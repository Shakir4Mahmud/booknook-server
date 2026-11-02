import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const port = process.env.PORT || 5000;

app.use(
  cors({
    origin: (process.env.CLIENT_URL || "http://localhost:3000").split(","),
  })
);
app.use(express.json());

const client = new MongoClient(process.env.MONGO_URI);
let booksCol;
let borrowsCol;

const categories = ["Fiction", "Science", "History", "Kids", "Others"];
const allowedDays = [3, 5, 7, 14];
const isId = (value) => /^[a-f\d]{24}$/i.test(String(value));

// ---------- Token check ---

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.AUTH_URL}/api/auth/jwks`)
);

async function verifyToken(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).send({ message: "Please login first." });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.AUTH_URL,
      audience: process.env.AUTH_URL,
    });
    req.user = {
      email: String(payload.email).toLowerCase(),
      name: payload.name,
    };
    next();
  } catch {
    res.status(401).send({ message: "Your login is not valid. Please login again." });
  }
}

// ---------- Book input check -----
function cleanBook(body) {
  const title = String(body.title || "").trim();
  const author = String(body.author || "").trim();
  const description = String(body.description || "").trim();
  const image = String(body.image || "").trim();
  const category = body.category;
  const totalCopies = Number(body.totalCopies);

  if (!title || !author) return { error: "Title and author are required." };
  if (!categories.includes(category)) return { error: "Pick a valid category." };
  if (description.length < 20) return { error: "Description is too short." };
  if (!Number.isInteger(totalCopies) || totalCopies < 1 || totalCopies > 50) {
    return { error: "Total copies must be between 1 and 50." };
  }

  return { data: { title, author, category, description, image, totalCopies } };
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.send("BookNook server is running");
});

// All books (public). Newest first. 
app.get("/books", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 0, 100);
  let cursor = booksCol.find().sort({ createdAt: -1 });
  if (limit) cursor = cursor.limit(limit);
  res.send(await cursor.toArray());
});

// One book
app.get("/books/:id", async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).send({ message: "Invalid book id." });
  }
  const book = await booksCol.findOne({ _id: new ObjectId(req.params.id) });
  if (!book) return res.status(404).send({ message: "Book not found." });
  res.send(book);
});

// Add a book. The owner comes from the token.
app.post("/books", verifyToken, async (req, res) => {
  const { data, error } = cleanBook(req.body);
  if (error) return res.status(400).send({ message: error });

  const book = {
    ...data,
    availableCopies: data.totalCopies,
    addedBy: { name: req.user.name, email: req.user.email },
    createdAt: new Date().toISOString(),
  };

  const result = await booksCol.insertOne(book);
  res.status(201).send({ ...book, _id: result.insertedId });
});

// Update a book. Only the person who added it.
app.patch("/books/:id", verifyToken, async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).send({ message: "Invalid book id." });
  }

  const book = await booksCol.findOne({ _id: new ObjectId(req.params.id) });
  if (!book) return res.status(404).send({ message: "Book not found." });
  if (book.addedBy.email !== req.user.email) {
    return res.status(403).send({ message: "You can only edit your own books." });
  }

  const { data, error } = cleanBook({ ...book, ...req.body });
  if (error) return res.status(400).send({ message: error });


  const borrowed = book.totalCopies - book.availableCopies;
  if (data.totalCopies < borrowed) {
    return res.status(400).send({
      message: `${borrowed} copies are borrowed right now, so total cannot go below ${borrowed}.`,
    });
  }

  const changes = {
    ...data,
    image: data.image || book.image,
    availableCopies: data.totalCopies - borrowed,
  };

  await booksCol.updateOne({ _id: book._id }, { $set: changes });
  res.send({ ...book, ...changes });
});

// Delete a book. Only the person who added it.
app.delete("/books/:id", verifyToken, async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).send({ message: "Invalid book id." });
  }

  const book = await booksCol.findOne({ _id: new ObjectId(req.params.id) });
  if (!book) return res.status(404).send({ message: "Book not found." });
  if (book.addedBy.email !== req.user.email) {
    return res.status(403).send({ message: "You can only delete your own books." });
  }

  await booksCol.deleteOne({ _id: book._id });

  await borrowsCol.deleteMany({ bookId: String(book._id) });
  res.send({ deleted: true });
});

// Borrow a book. The user comes from the token.
app.post("/borrows", verifyToken, async (req, res) => {
  const { bookId } = req.body;
  const days = Number(req.body.days) || 7;

  if (!isId(bookId)) {
    return res.status(400).send({ message: "Invalid book id." });
  }
  if (!allowedDays.includes(days)) {
    return res.status(400).send({ message: "Pick 3, 5, 7 or 14 days." });
  }

  const book = await booksCol.findOne({ _id: new ObjectId(bookId) });
  if (!book) return res.status(404).send({ message: "Book not found." });

  // cannot borrow own book.
  if (book.addedBy.email === req.user.email) {
    return res.status(403).send({ message: "This is your own book, you cannot borrow it." });
  }

  // No double borrow.
  const oldBorrow = await borrowsCol.findOne({
    bookId: String(book._id),
    userEmail: req.user.email,
  });
  if (oldBorrow) {
    return res.status(409).send({ message: "You already borrowed this book." });
  }

  // Take one copy. 
  const took = await booksCol.updateOne(
    { _id: book._id, availableCopies: { $gt: 0 } },
    { $inc: { availableCopies: -1 } }
  );
  if (took.modifiedCount === 0) {
    return res.status(400).send({ message: "Not Available. No copies left." });
  }

  const borrowDate = new Date();
  const returnDate = new Date(borrowDate.getTime() + days * 24 * 60 * 60 * 1000);

  const borrow = {
    bookId: String(book._id),
    bookTitle: book.title,
    bookImage: book.image,
    userEmail: req.user.email,
    borrowDate: borrowDate.toISOString(),
    returnDate: returnDate.toISOString(),
  };

  try {
    const result = await borrowsCol.insertOne(borrow);
    res.status(201).send({ ...borrow, _id: result.insertedId });
  } catch (err) {
   
    
    await booksCol.updateOne({ _id: book._id }, { $inc: { availableCopies: 1 } });
    if (err.code === 11000) {
      return res.status(409).send({ message: "You already borrowed this book." });
    }
    res.status(500).send({ message: "Could not borrow the book." });
  }
});

// My borrows. Only the logged in user's own records.
app.get("/borrows", verifyToken, async (req, res) => {
  const list = await borrowsCol
    .find({ userEmail: req.user.email })
    .sort({ borrowDate: -1 })
    .toArray();
  res.send(list);
});

// Return a book. Only the person who borrowed it.
app.delete("/borrows/:id", verifyToken, async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).send({ message: "Invalid borrow id." });
  }

  const borrow = await borrowsCol.findOne({ _id: new ObjectId(req.params.id) });
  if (!borrow) return res.status(404).send({ message: "Borrow record not found." });
  if (borrow.userEmail !== req.user.email) {
    return res.status(403).send({ message: "You can only return your own borrows." });
  }

  await borrowsCol.deleteOne({ _id: borrow._id });
  // Return the copy.
  await booksCol.updateOne(
    { _id: new ObjectId(borrow.bookId) },
    { $inc: { availableCopies: 1 } }
  );
  res.send({ returned: true });
});

// ---------- Start ------
async function start() {
  await client.connect();
  const db = client.db("BookNook");
  booksCol = db.collection("books");
  borrowsCol = db.collection("borrows");

  await borrowsCol.createIndex({ bookId: 1, userEmail: 1 }, { unique: true });

  console.log("You successfully connected to MongoDB!");

  app.listen(port, () => {
    console.log(`BookNook server running on port ${port}`);
  });
}

start().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
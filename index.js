import express from "express";
import "dotenv/config";
import { MongoClient } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());

const client = new MongoClient(process.env.MONGO_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}
const connnectClient = await connectToMongoDB();
const db = connnectClient.db("BookNook");

app.listen(port, () => {
  console.log(` app listening on port ${port}`);
});

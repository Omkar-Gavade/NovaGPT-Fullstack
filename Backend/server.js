import express from "express";
import "dotenv/config";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import mongoose from "mongoose";
import chatRoutes from "./routes/chat.js";

const ai = new GoogleGenAI({});

const app = express();
const PORT = 8080;

app.use(express.json());
app.use(cors());

app.use("/api", chatRoutes);

app.listen(PORT, () =>{
    console.log(`server running on ${PORT}`);
    connectDB();
});

const connectDB = async() =>{
    try{
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("connected with Database");
    } catch(err){
        console.log("failed to connect to DB",err);
    }
}

//GEMINI CHAT ROUTE (Official SDK Method)
// app.post("/test", async (req, res) => {
//   try {
//     const userMessage = req.body.message;

//     const response = await ai.models.generateContent({
//       model: "gemini-2.5-flash",
//       contents: userMessage
//     });

//     res.send(response.text);

//   } catch (err) {
//     console.error("Gemini SDK Error:", err);
//     res.status(500).send("Gemini API Error");
//   }
// });


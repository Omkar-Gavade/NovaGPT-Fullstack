import express from "express";
import "dotenv/config";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});

const app = express();
const PORT = 8080;

app.use(express.json());
app.use(cors());

app.listen(PORT, () =>{
    console.log("server running on PORT 8080")
});

//GEMINI CHAT ROUTE (Official SDK Method)
app.post("/test", async (req, res) => {
  try {
    const userMessage = req.body.message;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: userMessage
    });

    res.send(response.text);

  } catch (err) {
    console.error("Gemini SDK Error:", err);
    res.status(500).send("Gemini API Error");
  }
});


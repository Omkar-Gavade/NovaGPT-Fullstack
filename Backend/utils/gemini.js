import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// UTILITY FUNCTION FOR /chat ROUTE
export const generateGeminiReply = async (message) => {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(message);
  return result.response.text();
};

const getGeminiAPIresponse = async (req, res) => {
  try {
    const { message } = req.body;
    const reply = await generateGeminiReply(message);
    return res.send(reply);
  }  catch (err) {
    console.error("Gemini SDK Error:", err);
    res.status(500).send("Gemini API Error");
  }
};

export default getGeminiAPIresponse;
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// UTILITY FUNCTION FOR /chat ROUTE
// export const generateGeminiReply = async (message) => {
//   const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
//   const result = await model.generateContent(message);
//   return result.response.text();
// };

export const generateGeminiReply = async (message) => {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash", // ✅ more stable
    });

    const result = await model.generateContent(message);
    return result.response.text();

  } catch (err) {
    // ✅ Handle rate limit / overload gracefully
    if (err.status === 429) {
      return "⚠️ AI is busy right now. Please wait a few seconds and try again.";
    }

    if (err.status === 503) {
      return "⚠️ AI servers are overloaded. Please try again shortly.";
    }

    throw err; // other errors should still be logged
  }
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
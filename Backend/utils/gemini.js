import "dotenv/config";

import { GoogleGenerativeAI } from "@google/generative-ai"; 

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export const generateGeminiReply = async (message) => {
  try {
    
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash", 
    });

    const result = await model.generateContent(message);
    
    
    const response = await result.response;
    return response.text();

  } catch (err) {
    console.error("Gemini Error Detail:", err); 
    
    if (err.status === 429) {
      return "⚠️ Rate limit reached. Please wait a moment.";
    }
    return "⚠️ AI Service Error: " + err.message;
  }
};

const getGeminiAPIresponse = async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).send("Message is required");
    }

    const reply = await generateGeminiReply(message);
    
    
    return res.json({ reply }); 
    
  } catch (err) {
    console.error("Route Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export default getGeminiAPIresponse;


// import "dotenv/config";
// import { GoogleGenerativeAI } from "@google/generative-ai";

// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// // UTILITY FUNCTION FOR /chat ROUTE
// // export const generateGeminiReply = async (message) => {
// //   const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
// //   const result = await model.generateContent(message);
// //   return result.response.text();
// // };

// export const generateGeminiReply = async (message) => {
//   try {
//     const model = genAI.getGenerativeModel({
//       model: "gemini-3-flash", // ✅ more stable
//     });

//     const result = await model.generateContent(message);
//     return result.response.text();
    

//   } catch (err) {
//     // ✅ Handle rate limit / overload gracefully
//     if (err.status === 429) {
//       return "⚠️ AI is busy right now. Please wait a few seconds and try again.";
//     }

//     if (err.status === 503) {
//       return "⚠️ AI servers are overloaded. Please try again shortly.";
//     }

//     throw err; // other errors should still be logged
//   }
// };

// const getGeminiAPIresponse = async (req, res) => {
//   try {
//     const { message } = req.body;
//     const reply = await generateGeminiReply(message);
//     return res.send(reply);
//   }  catch (err) {
//     console.error("Gemini SDK Error:", err);
//     res.status(500).send("Gemini API Error");
//   }
// };

// export default getGeminiAPIresponse;
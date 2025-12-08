import express from "express";
import Thread from "../models/Thread.js"
import { generateGeminiReply } from "../utils/gemini.js";
const router = express.Router();

//test
router.post("/test", async(req,res)=>{
    try{
        const thread = new Thread({
            threadId:"xyz",
            title:"Testing New Thread"
        });

        const response = await thread.save();
        res.send(response);

    } catch(err){
        console.log(err);
        res.status(500).json({error:"failed to save in DB"});
    }
});

//Get all threads 
router.get("/thread", async(req, res)=>{
    try{
        const threads = await Thread.find({}).sort({updatedAt: -1});
        res.json(threads);
        //dedcreasing order of updated at...most recent dataon top
    } catch(err){
        console.log(err);
        res.status(500).json({error: "Failed to fetch threads"});
    }
});

router.get("/thread/:threadId", async(req, res)=>{

    const {threadId} = req.params;

    try{
        const thread = await Thread.findOne({threadId});

        if(!thread){
            res.status(404).json({error: "Thread not found"});
        }

        res.json(thread.message);
    } catch(err){
        console.log(err);
        res.status(500).json({error: "Failed to fetch chat"});
    }
});

router.delete("/thread/:threadId", async(req, res) =>{
    const {threadId} = req.params;

    try{
       const deletedThread = await Thread.findOneAndDelete({ threadId });

       if(!deletedThread){
        return res.status(404).json({error: "Thread not found"});
       }
       res.status(200).json({success: "Thread deleted successfully"});

    } catch(err){
        console.log(err);
        res.status(500).json({error: "Failed to fetch thread"});
    }
});

//CHAT ROUTE (GEMINI + MONGODB)
router.post("/chat", async (req, res) => {
  const { threadId, message } = req.body;

  if (!threadId || !message) {
    return res.status(400).json({ error: "missing required fields" });
  }

  try {
    let thread = await Thread.findOne({ threadId });

    if (!thread) {
      thread = new Thread({
        threadId,
        title: message,
        message: [{ role: "user", content: message }]
      });
    } else {
      thread.message.push({ role: "user", content: message });
    }

    // ✅ CORRECT GEMINI CALL
    const assistantReply = await generateGeminiReply(message);

    thread.message.push({ role: "assistant", content: assistantReply });
    thread.updatedAt = new Date();

    await thread.save();
    res.json({ reply: assistantReply });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "something went wrong" });
  }
});


export default router;
import "./Chat.css";
import { useContext, useState,useEffect } from "react";
import { MyContext } from "./MyContext";
import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css"

//react-markdown
//rehype-highlight


function Chat(){
    const {newChat,prevChats, reply} = useContext(MyContext);
    const [latestReply, setLatestReply] = useState(null);

    useEffect(() =>{
        if(reply === null) {
            setLatestReply(null); //prevchat load
            return;
        }

        //latestReply separate => typing effect create
        if(!prevChats?.length) return;

        const content = reply.split(" "); //individual words

        let idx = 0;
        const interval = setInterval(() =>{
            setLatestReply(content.slice(0, idx+1).join(" "));

            idx++;
            if(idx >= content.length) clearInterval(interval);
        }, 40)
        return () => clearInterval(interval);
    },[prevChats,reply])


    return(
        <>
        {newChat && <h1>Start a New Chat</h1>} 
        <div className="chats">
            {
                prevChats?.slice(0, -1).map((chat,idx)=>
                <div className={chat.role === "user"? "userDiv" : "gptDiv"} key={idx}>
                    {
                        chat.role ==="user"?
                         <p className="userMessage">{chat.content}</p> :
                          <ReactMarkdown
                          rehypePlugins={rehypeHighlight} >{chat.content}</ReactMarkdown>
                    }

                </div>
                )
            }

            {
                prevChats.length > 0 && latestReply != null &&
                <div className="gptDiv" key={"typing"}>
                    <ReactMarkdown rehypePlugins={[rehypeHighlight]} >{latestReply}</ReactMarkdown>
               </div>
            }

            {
                 prevChats.length > 0 && latestReply === null &&
                 <div className="gptDiv" key={"typing"}>
                    <ReactMarkdown rehypePlugins={[rehypeHighlight]} >{prevChats[prevChats.length-1].content}</ReactMarkdown>
               </div>
            }

           
        </div>

      
        
        </>
    )
}
export default Chat;


// import "./Chat.css";
// import { useContext, useState, useEffect } from "react";
// import { MyContext } from "./MyContext";
// import ReactMarkdown from "react-markdown";
// import rehypeHighlight from "rehype-highlight";
// import "highlight.js/styles/github-dark.css";

// function Chat() {
//   const { newChat, prevChats, reply } = useContext(MyContext);
//   const [latestReply, setLatestReply] = useState(null);

//   useEffect(() => {
//     // OLD THREAD CLICK → no typing
//     if (reply === null) {
//       setLatestReply(null);
//       return;
//     }

//     // NEW MESSAGE → typing animation
//     const words = reply.split(" ");
//     let idx = 0;

//     const interval = setInterval(() => {
//       setLatestReply(words.slice(0, idx + 1).join(" "));
//       idx++;
//       if (idx >= words.length) clearInterval(interval);
//     }, 40);

//     return () => clearInterval(interval);
//   }, [reply]);

//   return (
//     <>
//       {newChat && <h1>Start a New Chat</h1>}

//       <div className="chats">
//         {/* Render ALL previous messages */}
//         {prevChats.map((chat, idx) => {
//           // If this is the LAST assistant message AND typing is active → skip
//           const isLast =
//             idx === prevChats.length - 1 &&
//             chat.role === "assistant" &&
//             latestReply !== null;

//           if (isLast) return null;

//           return (
//             <div
//               key={idx}
//               className={chat.role === "user" ? "userDiv" : "gptDiv"}
//             >
//               {chat.role === "user" ? (
//                 <p className="userMessage">{chat.content}</p>
//               ) : (
//                 <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
//                   {chat.content}
//                 </ReactMarkdown>
//               )}
//             </div>
//           );
//         })}

//         {/* Typing animation ONLY for new reply */}
//         {latestReply && (
//           <div className="gptDiv">
//             <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
//               {latestReply}
//             </ReactMarkdown>
//           </div>
//         )}
//       </div>
//     </>
//   );
// }

// export default Chat;
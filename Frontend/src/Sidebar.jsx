import "./Sidebar.css";
import { useContext, useEffect } from "react";
import { MyContext } from "./MyContext.jsx";
import { v4 as uuidv4 } from "uuid";

function Sidebar() {
  const {
    allThreads,
    setAllThreads,
    currThreadId,
    setNewChat,
    setPrompt,
    setReply,
    setCurrThreadId,
    setPrevChats,
  } = useContext(MyContext);

  const getAllThreads = async () => {
    try {
      const response = await fetch("http://localhost:8080/api/thread");
      const res = await response.json();
      const filteredData = res.map((thread) => ({
        threadId: thread.threadId,
        title: thread.title,
      }));
      console.log(filteredData);
      setAllThreads(filteredData);
    } catch (err) {
      console.log(err);
    }
  };

  useEffect(() => {
    getAllThreads();
  }, []);

  const createNewChat = () => {
    setNewChat(true);
    setPrompt("");
    setReply(null);
    setCurrThreadId(uuidv4());
    setPrevChats([]);
  };

  const changeThread = async (newThreadId) => {
    setCurrThreadId(newThreadId);

    try {
      const response = await fetch(
        `http://localhost:8080/api/thread/${newThreadId}`
      );
      const res = await response.json();

      const chats = Array.isArray(res)
        ? res
        : res.message || res.messages || [];

      setPrevChats(chats);
      setNewChat(false);
      setReply(null);
    } catch (err) {
      console.log(err);
    }
  };

  const deleteThread = async (threadId) => {
  try {
    const response = await fetch(
      `http://localhost:8080/api/thread/${threadId}`,
      { method: "DELETE" }
    );

    const res = await response.json();
    console.log(res);

    //update threads re-render
    setAllThreads(prev => prev.filter(thread => thread.threadId !== threadId));

    if(threadId == currThreadId){
      createNewChat();
    }

  } catch (err) {
    console.log(err);
  }
};

  return (
    <section className="sidebar">
      {/* new chat button */}
      <button onClick={createNewChat}>
        <img
          src="src/assets/blacklogo.png"
          alt="gpt logo"
          className="logo"
        ></img>
        <span>
          <i className="fa-solid fa-pen-to-square"></i>
        </span>
      </button>
      {/* { history} */}

      <ul className="history">
        {allThreads?.map((thread, idx) => (
          // <li key={idx} onClick={() => changeThread(thread.threadId)}>{thread.title}</li>
          <li
            key={thread.threadId}
            onClick={() => {
              console.log("CLICKED THREAD:", thread.threadId);
              changeThread(thread.threadId);
            }}
            className={thread.threadId === currThreadId ? "highlighted" : " "}
          >
            {thread.title}
            <i className="fa-solid fa-trash"
            onClick={(e) =>{
              e.stopPropagation();
              deleteThread(thread.threadId);
            }}
            ></i>
          </li>
        ))}
      </ul>
      {/* {sign} */}
      <div className="sign">
        <p>By Omkar Gavade
           &hearts;</p>
      </div>
    </section>
  );
}

export default Sidebar;

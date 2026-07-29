import express from "express";
import "dotenv/config";
import cors from "cors";
import mongoose from "mongoose";
import chatRoutes from "./routes/chat.js";
import { validateEnv } from "./providers/utils/env.js";
import { registry } from "./providers/registry/index.js";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "1mb" }));
app.use(cors());

// health/readiness probe that never depends on the database
app.get("/api/health", (req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

app.use("/api", chatRoutes);

/**
 * Connect to MongoDB in the background and keep retrying. The HTTP server does
 * NOT wait on this: stateless routes (`/api/models`, `/api/providers`) must stay
 * up even when the database is unreachable, so a DB outage can never blank the
 * model dropdown. Thread routes fail fast (short server-selection timeout) and
 * recover automatically once Mongo comes back.
 */
async function connectMongo(attempt = 1) {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log("Connected to database");
  } catch (err) {
    const delay = Math.min(30_000, 2000 * attempt);
    console.error(`MongoDB not reachable (${err.code || err.message}); retrying in ${delay / 1000}s`);
    setTimeout(() => connectMongo(attempt + 1), delay);
  }
}

function startServer() {
  validateEnv(); // fail fast only on missing required config; report providers
  registry.startHealthMonitor(); // auto-recover suspect providers in the background

  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });

  connectMongo(); // non-blocking; the API is already serving
}

startServer();

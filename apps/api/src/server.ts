import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { attachMissionSocket } from "./realtime/mission-socket.js";
import { markInterruptedMissionsFailed } from "./services/mission.service.js";

const start = async () => {
  await mongoose.connect(env.MONGODB_URI);
  await markInterruptedMissionsFailed();
  const app = createApp();
  const server = createServer(app);
  attachMissionSocket(server);
  server.listen(env.PORT, () => {
    console.info(`NEXUS API listening on port ${env.PORT}`);
  });
};

start().catch((error: unknown) => {
  console.error("Failed to start NEXUS API", error);
  process.exitCode = 1;
});

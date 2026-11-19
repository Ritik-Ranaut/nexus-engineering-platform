import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { attachMissionSocket } from "./realtime/mission-socket.js";
import { markInterruptedMissionsFailed } from "./services/mission.service.js";
import { recoverInterruptedProjectIndexing } from "./services/project.service.js";

const start = async () => {
  await mongoose.connect(env.MONGODB_URI);
  await markInterruptedMissionsFailed();
  const app = createApp();
  const server = createServer(app);
  attachMissionSocket(server);
  server.listen(env.PORT, () => {
    // A duplicate watcher must not recover projects owned by the active listener.
    void recoverInterruptedProjectIndexing().then(() => {
      console.info(`NEXUS API listening on port ${env.PORT}`);
    }).catch((error: unknown) => {
      console.error("Failed to recover interrupted project indexing", error);
      server.close(() => {
        process.exitCode = 1;
      });
    });
  });
};

start().catch((error: unknown) => {
  console.error("Failed to start NEXUS API", error);
  process.exitCode = 1;
});

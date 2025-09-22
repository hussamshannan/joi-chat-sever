// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(
  cors({
    origin: [
      "https://joichat.netlify.app",
      "http://localhost:5173",
      "http://localhost:3001",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "https://joichat.netlify.app",
      "http://localhost:5173",
      "http://localhost:3001",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
  maxHttpBufferSize: 1e8, // 100MB max file size
});

// Store room data
const rooms = new Map();

// Error handling middleware for Express
app.use((error, req, res, next) => {
  console.error("Express Error:", error);
  res.status(500).json({ error: "Internal server error" });
});

// Utility function for safe room operations
const safeRoomOperation = (roomId, operation) => {
  try {
    if (!roomId || typeof roomId !== "string") {
      throw new Error("Invalid room ID");
    }

    if (!rooms.has(roomId)) {
      throw new Error("Room does not exist");
    }

    return operation(rooms.get(roomId));
  } catch (error) {
    console.error("Room operation error:", error.message);
    throw error;
  }
};

// Validate socket data
const validateSocketData = (data, requiredFields = []) => {
  if (!data) {
    throw new Error("No data provided");
  }

  for (const field of requiredFields) {
    if (!data[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  return true;
};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Handle join-room with error handling
  socket.on("join-room", (roomId) => {
    try {
      if (!roomId || typeof roomId !== "string") {
        throw new Error("Invalid room ID format");
      }

      console.log(`User ${socket.id} joining room: ${roomId}`);

      // Leave any previous rooms
      const previousRooms = Array.from(socket.rooms).filter(
        (room) => room !== socket.id
      );
      for (const room of previousRooms) {
        socket.leave(room);
        console.log(`User ${socket.id} left room: ${room}`);
      }

      // Join new room
      socket.join(roomId);
      socket.roomId = roomId;

      // Initialize room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          users: new Set(),
          createdAt: new Date().toISOString(),
        });
        console.log(`Created new room: ${roomId}`);
      }

      // Add user to room
      const room = rooms.get(roomId);
      if (room.users.size >= 10) {
        // Limit room size
        throw new Error("Room is full (max 10 users)");
      }

      room.users.add(socket.id);

      // Notify others in the room
      socket.to(roomId).emit("user-connected", socket.id);

      // Confirm room joined and send current users count
      const userCount = room.users.size;
      socket.emit("room-joined", { roomId, userCount });

      console.log(`User ${socket.id} joined room: ${roomId}`);
      console.log(`Room ${roomId} now has ${userCount} users`);
    } catch (error) {
      console.error("Join-room error:", error.message);
      socket.emit("error", {
        type: "join-room",
        message: error.message,
        roomId: roomId,
      });
    }
  });

  // Handle send-message with validation
  socket.on("send-message", (data) => {
    try {
      validateSocketData(data, ["id", "text", "timestamp"]);

      if (!socket.roomId) {
        throw new Error("User not in a room");
      }

      if (data.text && data.text.length > 1000) {
        throw new Error("Message too long (max 1000 characters)");
      }

      console.log("Message received from", socket.id, ":", data);

      // Broadcast to everyone in the room except the sender
      socket.to(socket.roomId).emit("chat-message", {
        id: data.id,
        text: data.text,
        timestamp: data.timestamp,
        sender: socket.id,
      });

      console.log(`Message broadcast to room: ${socket.roomId}`);
    } catch (error) {
      console.error("Send-message error:", error.message);
      socket.emit("error", {
        type: "send-message",
        message: error.message,
      });
    }
  });

  // Handle image with validation
  socket.on("image", (data) => {
    try {
      validateSocketData(data, ["id", "timestamp"]);

      if (!socket.roomId) {
        throw new Error("User not in a room");
      }

      console.log("Image received from", socket.id);

      // Broadcast to everyone in the room except the sender
      socket.to(socket.roomId).emit("receive-image", {
        id: data.id,
        imgData: data,
        isMe: false,
        timestamp: data.timestamp,
        sender: socket.id,
      });
    } catch (error) {
      console.error("Image error:", error.message);
      socket.emit("error", {
        type: "image",
        message: error.message,
      });
    }
  });

  // Handle message-read with validation
  socket.on("message-read", (data) => {
    try {
      validateSocketData(data, ["messageId", "timestamp"]);

      if (!socket.roomId) {
        throw new Error("User not in a room");
      }

      console.log("Message read receipt received from", socket.id, ":", data);

      safeRoomOperation(socket.roomId, (room) => {
        const otherUsers = Array.from(room.users).filter(
          (id) => id !== socket.id
        );

        if (otherUsers.length > 0) {
          otherUsers.forEach((userId) => {
            const userSocket = io.sockets.sockets.get(userId);
            if (userSocket) {
              userSocket.emit("message-read", {
                messageId: data.messageId,
                timestamp: data.timestamp,
                readerId: socket.id,
              });
            } else {
              // Store receipt if user is not connected
              if (!room.pendingReadReceipts) room.pendingReadReceipts = {};
              if (!room.pendingReadReceipts[userId])
                room.pendingReadReceipts[userId] = [];
              room.pendingReadReceipts[userId].push(data);
            }
          });
        }
      });
    } catch (error) {
      console.error("Message-read error:", error.message);
      socket.emit("error", {
        type: "message-read",
        message: error.message,
      });
    }
  });

  // Handle edit-message with validation
  socket.on("edit-message", (data) => {
    try {
      validateSocketData(data, ["messageId", "newText", "roomId"]);

      if (data.newText.length > 1000) {
        throw new Error("Message too long (max 1000 characters)");
      }

      console.log("Editing message:", data.messageId);

      // Broadcast the edited message to all users in the room
      socket.to(data.roomId).emit("message-edited", {
        messageId: data.messageId,
        newText: data.newText,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Edit-message error:", error.message);
      socket.emit("error", {
        type: "edit-message",
        message: error.message,
      });
    }
  });

  // Handle audio calls with validation
  socket.on("audio-call-start", (data) => {
    try {
      validateSocketData(data, ["roomId"]);

      console.log("Audio call started in room:", data.roomId);

      socket.to(data.roomId).emit("audio-call-started", {
        userId: socket.id,
        startedBy: "them",
        timestamp: new Date().toISOString(),
      });

      socket.emit("audio-call-started", {
        userId: socket.id,
        startedBy: "me",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Audio-call-start error:", error.message);
      socket.emit("error", {
        type: "audio-call-start",
        message: error.message,
      });
    }
  });

  socket.on("audio-call-end", (data) => {
    try {
      validateSocketData(data, ["roomId"]);

      console.log("Audio call ended in room:", data.roomId);

      socket.to(data.roomId).emit("audio-call-ended", {
        userId: socket.id,
        endedBy: "them",
        timestamp: new Date().toISOString(),
      });

      socket.emit("audio-call-ended", {
        userId: socket.id,
        endedBy: "me",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Audio-call-end error:", error.message);
      socket.emit("error", {
        type: "audio-call-end",
        message: error.message,
      });
    }
  });

  // Handle WebRTC signaling with validation
  socket.on("audio-offer", (data) => {
    try {
      validateSocketData(data, ["roomId", "offer"]);

      socket.to(data.roomId).emit("audio-offer", {
        offer: data.offer,
        from: socket.id,
      });
    } catch (error) {
      console.error("Audio-offer error:", error.message);
      socket.emit("error", {
        type: "audio-offer",
        message: error.message,
      });
    }
  });

  socket.on("audio-answer", (data) => {
    try {
      validateSocketData(data, ["roomId", "answer"]);

      socket.to(data.roomId).emit("audio-answer", {
        answer: data.answer,
        from: socket.id,
      });
    } catch (error) {
      console.error("Audio-answer error:", error.message);
      socket.emit("error", {
        type: "audio-answer",
        message: error.message,
      });
    }
  });

  socket.on("ice-candidate", (data) => {
    try {
      validateSocketData(data, ["roomId", "candidate"]);

      socket.to(data.roomId).emit("ice-candidate", {
        candidate: data.candidate,
        from: socket.id,
      });
    } catch (error) {
      console.error("Ice-candidate error:", error.message);
      socket.emit("error", {
        type: "ice-candidate",
        message: error.message,
      });
    }
  });

  // Handle disconnect with cleanup
  socket.on("disconnect", (reason) => {
    console.log("User disconnected:", socket.id, "Reason:", reason);

    try {
      if (socket.roomId) {
        safeRoomOperation(socket.roomId, (room) => {
          // Remove user from room
          room.users.delete(socket.id);

          // Notify others in the room
          socket.to(socket.roomId).emit("user-disconnected", socket.id);

          console.log(`User ${socket.id} removed from room: ${socket.roomId}`);
          const userCount = room.users.size;
          console.log(`Room ${socket.roomId} now has ${userCount} users`);

          // Clean up empty rooms after a delay
          if (userCount === 0) {
            setTimeout(() => {
              if (
                rooms.has(socket.roomId) &&
                rooms.get(socket.roomId).users.size === 0
              ) {
                rooms.delete(socket.roomId);
                console.log(`Room ${socket.roomId} deleted (empty)`);
              }
            }, 5000); // 5 second delay
          }
        });
      }
    } catch (error) {
      console.error("Disconnect cleanup error:", error.message);
    }
  });

  // Handle socket errors
  socket.on("error", (error) => {
    console.error("Socket error for", socket.id, ":", error);
  });
});

// Global error handlers
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Don't exit in production, let the process manager handle it
  if (process.env.NODE_ENV === "development") {
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

server.on("error", (error) => {
  console.error("Server error:", error);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

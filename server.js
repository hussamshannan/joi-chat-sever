// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
var x;
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
});

// Store room data
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomId) => {
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
      });
      console.log(`Created new room: ${roomId}`);
    }

    // Add user to room
    rooms.get(roomId).users.add(socket.id);

    // Notify others in the room
    socket.to(roomId).emit("user-connected", socket.id);

    // Confirm room joined and send current users count
    const userCount = rooms.get(roomId).users.size;
    socket.emit("room-joined", { roomId, userCount });

    console.log(`User ${socket.id} joined room: ${roomId}`);
    console.log(`Room ${roomId} now has ${userCount} users`);
  });
  // In the server.js file, update the send-message handler

  socket.on("send-message", (data) => {
    console.log("Message received from", socket.id, ":", data);

    if (socket.roomId) {
      // Broadcast to everyone in the room except the sender
      socket.to(socket.roomId).emit("chat-message", {
        id: data.id, // Include the message ID
        text: data.text,
        timestamp: data.timestamp,
        sender: socket.id,
      });
      console.log(`Message broadcast to room: ${socket.roomId}`);
    } else {
      console.log("User not in a room, cannot send message");
      socket.emit("error", "You are not in a room. Please join a room first.");
    }
  });
  socket.on("message-read", (data) => {
    console.log("Message read receipt received from", socket.id, ":", data);

    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      const otherUsers = Array.from(room.users).filter(
        (id) => id !== socket.id
      );

      if (otherUsers.length > 0) {
        // Send read receipt to other users in the room
        otherUsers.forEach((userId) => {
          const userSocket = io.sockets.sockets.get(userId);
          if (userSocket) {
            console.log("Sending read receipt to user:", userId);
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
    }
  });
  socket.on("disconnect", (reason) => {
    console.log("User disconnected:", socket.id, "Reason:", reason);

    if (socket.roomId && rooms.has(socket.roomId)) {
      // Remove user from room
      rooms.get(socket.roomId).users.delete(socket.id);

      // Notify others in the room
      socket.to(socket.roomId).emit("user-disconnected", socket.id);

      console.log(`User ${socket.id} removed from room: ${socket.roomId}`);
      const userCount = rooms.get(socket.roomId).users.size;
      console.log(`Room ${socket.roomId} now has ${userCount} users`);

      // Clean up empty rooms
      if (userCount === 0) {
        rooms.delete(socket.roomId);
        console.log(`Room ${socket.roomId} deleted (empty)`);
      }
    }
  });
  // Handle audio call start
  socket.on("audio-call-start", (data) => {
    console.log("Audio call started in room:", data.roomId);

    socket.to(data.roomId).emit("audio-call-started", {
      userId: socket.id,
      startedBy: "them", // For other users, it's "them"
      timestamp: new Date().toISOString(),
    });
    socket.emit("audio-call-started", {
      userId: socket.id,
      startedBy: "me", // For the user who ended, it's "me"
      timestamp: new Date().toISOString(),
    });
  });

  // Handle audio call end
  socket.on("audio-call-end", (data) => {
    console.log("Audio call ended in room:", data.roomId);

    // Notify other users in the room
    socket.to(data.roomId).emit("audio-call-ended", {
      userId: socket.id,
      endedBy: "them", // For other users, it's "them"
      timestamp: new Date().toISOString(),
    });

    // Notify the user who ended the call
    socket.emit("audio-call-ended", {
      userId: socket.id,
      endedBy: "me", // For the user who ended, it's "me"
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("answered", (data) => {
    socket.to(data.roomId).emit("answered", {
      isAnswer: data.isAnswer,
    });
  });
  // Handle WebRTC signaling for audio calls
  socket.on("audio-offer", (data) => {
    socket.to(data.roomId).emit("audio-offer", {
      offer: data.offer,
      from: socket.id,
    });
  });

  socket.on("audio-answer", (data) => {
    socket.to(data.roomId).emit("audio-answer", {
      answer: data.answer,
      from: socket.id,
    });
  });

  socket.on("ice-candidate", (data) => {
    socket.to(data.roomId).emit("ice-candidate", {
      candidate: data.candidate,
      from: socket.id,
    });
  });
  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
});

// Add error handling to the server
server.on("error", (error) => {
  console.error("Server error:", error);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

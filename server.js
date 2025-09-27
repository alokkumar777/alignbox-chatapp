require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const mysql = require("mysql2/promise");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// DB pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "chat_app",
  waitForConnections: true,
  connectionLimit: 10,
});

// ensure uploads directory
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// multer for avatar uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
  },
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

// helpers
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}
async function getUserByEmail(email) {
  const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [
    email,
  ]);
  return rows[0];
}
async function getUserById(id) {
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
  return rows[0];
}

// Register
app.post("/api/register", upload.single("avatar"), async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "Missing fields" });

    if (await getUserByEmail(email))
      return res.status(400).json({ error: "Email already in use" });

    const hash = await bcrypt.hash(password, 10);
    const avatar_path = req.file ? `/uploads/${req.file.filename}` : null;
    const [result] = await pool.query(
      "INSERT INTO users (username,email,password_hash,avatar_path) VALUES (?,?,?,?)",
      [username, email, hash, avatar_path]
    );
    const user = { id: result.insertId, username, email, avatar_path };
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await getUserByEmail(email);
    if (!user) return res.status(400).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });
    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_path: user.avatar_path,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// middleware to verify token
async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "No token" });
  const token = auth.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = await getUserById(payload.id);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// fetch last messages
app.get("/api/messages", authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM messages ORDER BY id DESC LIMIT 100"
  );
  // return in ascending order
  res.json(rows.reverse());
});

// get my profile
app.get("/api/me", authMiddleware, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    username: u.username,
    email: u.email,
    avatar_path: u.avatar_path,
  });
});

// save message helper
async function saveMessage({
  user_id,
  sender_name,
  anonymous,
  avatar_path,
  content,
}) {
  const [resInsert] = await pool.query(
    "INSERT INTO messages (user_id, sender_name, anonymous, avatar_path, content) VALUES (?,?,?,?,?)",
    [user_id, sender_name, anonymous ? 1 : 0, avatar_path, content]
  );
  const [rows] = await pool.query("SELECT * FROM messages WHERE id = ?", [
    resInsert.insertId,
  ]);
  return rows[0];
}

// Socket.IO auth on connect
io.use(async (socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error("No token"));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(payload.id);
    if (!user) return next(new Error("User not found"));
    socket.user = user;
    next();
  } catch (err) {
    next(new Error("Auth error"));
  }
});

io.on("connection", (socket) => {
  const user = socket.user;
  socket.join("global");
  console.log("user connected", user.username);

  socket.on("send_message", async (payload) => {
    // payload: { content: string, anonymous: boolean }
    try {
      const anonymous = !!payload.anonymous;
      const sender_name = anonymous ? "Anonymous" : user.username;
      const avatar_path = anonymous ? null : user.avatar_path; // if anonymous, server will provide anon avatar front-end
      const msgRow = await saveMessage({
        user_id: user.id,
        sender_name,
        anonymous,
        avatar_path,
        content: payload.content,
      });
      // broadcast to all in 'global'
      const out = {
        id: msgRow.id,
        user_id: msgRow.user_id,
        sender_name: msgRow.sender_name,
        anonymous: !!msgRow.anonymous,
        avatar_path: msgRow.avatar_path,
        content: msgRow.content,
        created_at: msgRow.created_at,
      };
      io.to("global").emit("new_message", out);
    } catch (err) {
      console.error("send_message error", err);
    }
  });
  socket.on("disconnect", () => {
    console.log("user disconnected", user.username);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`App is running on http://localhost:${PORT}/html/login.html`);
});
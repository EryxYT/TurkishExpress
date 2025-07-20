const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const usersFile = "users.json";
const historyFile = "history.json";

// Helpers for reading/writing JSON files
function readUsers() {
  if (!fs.existsSync(usersFile)) return [];
  return JSON.parse(fs.readFileSync(usersFile, "utf8"));
}
function writeUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function readHistory() {
  if (!fs.existsSync(historyFile)) return {};
  return JSON.parse(fs.readFileSync(historyFile, "utf8"));
}
function writeHistory(history) {
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

// Get client IP (supports proxies)
function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "Bilinmiyor"
  );
}

// Admin kart numaraları
const adminCards = ["000000001"]; // Buraya kendi admin kart numaranızı ekleyin

// Rastgele 9 haneli kart numarası oluştur
function generateCardNumber() {
  const users = readUsers();
  let card;
  do {
    card = Math.floor(100000000 + Math.random() * 900000000).toString();
  } while (users.some((u) => u.cardNumber === card));
  return card;
}

// İşlem geçmişine kayıt ekler
function addHistory(cardNumber, entry) {
  const history = readHistory();
  if (!history[cardNumber]) history[cardNumber] = [];
  history[cardNumber].push(entry);
  writeHistory(history);
}

app.use(express.json());
app.use(express.static("public"));

// --- API ---

// Kart talep etme
app.post("/api/request-card", (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin || !/^\d{4}$/.test(pin)) {
    return res.json({ success: false, error: "Geçerli isim ve 4 haneli PIN giriniz." });
  }

  const users = readUsers();
  if (users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    return res.json({ success: false, error: "Bu isim zaten kayıtlı." });
  }

  const cardNumber = generateCardNumber();
  const ip = getClientIP(req);
  const createdAt = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });

  const newUser = {
    name,
    cardNumber,
    pin,
    password: pin, // Admin paneli için gösterilecek
    balance: 0,
    frozen: false,
    ip,
    createdAt,
    mode: "dark", // varsayılan modu "dark"
  };

  users.push(newUser);
  writeUsers(users);

  res.json({ success: true, cardNumber });
});

// Giriş yap
app.post("/api/login", (req, res) => {
  const { cardNumber, pin } = req.body;
  if (!cardNumber || !pin) {
    return res.json({ success: false, error: "Kart numarası ve PIN gerekli." });
  }

  const users = readUsers();
  const user = users.find((u) => u.cardNumber === cardNumber && u.pin === pin);
  if (!user) {
    return res.json({ success: false, error: "Geçersiz kart numarası veya PIN." });
  }

  // IP değişimi kontrolü ve bildirim gönder
  const oldIP = user.ip;
  const newIP = getClientIP(req);
  if (oldIP && oldIP !== newIP) {
    // Aynı hesaba farklı IP’den giriş bildirimi
    io.to(cardNumber).emit("notify", {
      title: "Dikkat!",
      body: `${user.name}, hesabına başka bir IP’den giriş yapıldı (${newIP}). Canlı desteğe danışın.`,
      icon: "/sounds/alert.png",
      sound: "/sounds/alert.mp3",
    });
  }

  user.ip = newIP;
  writeUsers(users);

  const history = readHistory();
  res.json({
    success: true,
    name: user.name,
    cardNumber: user.cardNumber,
    balance: user.balance,
    frozen: user.frozen || false,
    admin: adminCards.includes(cardNumber),
    history: history[cardNumber] || [],
    mode: user.mode, // kullanıcı modu dönüyoruz
  });
});

// Modu güncelleme (dark/light)
app.post("/api/set-mode", (req, res) => {
  const { cardNumber, mode } = req.body;
  if (!cardNumber || !["dark", "light"].includes(mode)) {
    return res.json({ success: false, error: "Geçersiz veri." });
  }
  const users = readUsers();
  const user = users.find((u) => u.cardNumber === cardNumber);
  if (!user) return res.json({ success: false, error: "Kullanıcı bulunamadı." });

  user.mode = mode;
  writeUsers(users);
  res.json({ success: true, mode });
});

// Para gönderme (kullanıcı adıyla, not destekli)
app.post("/api/send-money-by-name", (req, res) => {
  const { fromCard, toUsername, amount, note } = req.body;
  if (!fromCard || !toUsername || typeof amount !== "number" || amount <= 0) {
    return res.json({ success: false, error: "Geçersiz veri." });
  }

  const users = readUsers();
  const sender = users.find((u) => u.cardNumber === fromCard);
  const receiver = users.find((u) => u.name.toLowerCase() === toUsername.toLowerCase());

  if (!sender || sender.frozen) {
    return res.json({ success: false, error: "Gönderen hesabı geçersiz veya dondurulmuş." });
  }
  if (!receiver || receiver.frozen) {
    return res.json({ success: false, error: "Alıcı hesabı geçersiz veya dondurulmuş." });
  }
  if (sender.balance < amount) {
    return res.json({ success: false, error: "Yetersiz bakiye." });
  }

  sender.balance -= amount;
  receiver.balance += amount;
  writeUsers(users);

  const now = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  addHistory(fromCard, {
    type: "GÖNDERİLDİ",
    amount: -amount,
    to: receiver.name,
    date: now,
    note: note || "",
  });
  addHistory(receiver.cardNumber, {
    type: "ALINDI",
    amount: amount,
    from: sender.name,
    date: now,
    note: note || "",
  });

  // Notlu para gönderme bildirimi (not varsa gönder)
  if (note && note.trim() !== "") {
    io.to(receiver.cardNumber).emit("notify", {
      title: "Para Geldi 💰",
      body: `${sender.name} sana ${amount}₺ gönderdi.\nNot: ${note}`,
      icon: "/sounds/coin.png",
      sound: "/sounds/coin.mp3",
    });
  }

  const history = readHistory();
  res.json({ success: true, newBalance: sender.balance, history: history[fromCard] || [] });
});

// Hesap bilgilerini güncelle (isim ve/veya pin)
app.post("/api/update-account", (req, res) => {
  const { cardNumber, newName, newPin } = req.body;
  if (!cardNumber) return res.json({ success: false, error: "Kart numarası gerekli." });

  const users = readUsers();
  const user = users.find((u) => u.cardNumber === cardNumber);
  if (!user) return res.json({ success: false, error: "Kullanıcı bulunamadı." });

  // İsim değiştir
  if (newName && newName.trim() !== user.name) {
    if (users.some((u) => u.name.toLowerCase() === newName.toLowerCase())) {
      return res.json({ success: false, error: "Bu isim zaten kullanılıyor." });
    }
    user.name = newName.trim();
  }

  // PIN değiştir
  if (newPin) {
    if (!/^\d{4}$/.test(newPin)) {
      return res.json({ success: false, error: "PIN 4 haneli olmalı." });
    }
    user.pin = newPin;
    user.password = newPin; // admin panel için
  }

  writeUsers(users);
  res.json({ success: true, name: user.name });
});

// --- Admin API ---

app.get("/api/users", (req, res) => {
  const users = readUsers().map((u) => ({
    name: u.name,
    cardNumber: u.cardNumber,
    balance: u.balance,
    frozen: u.frozen,
    ip: u.ip,
    createdAt: u.createdAt,
    password: u.password,
    mode: u.mode,
  }));
  res.json(users);
});

app.post("/api/admin/reset-balance", (req, res) => {
  /* ... */
});
app.post("/api/admin/add-balance", (req, res) => {
  /* ... */
});
app.post("/api/admin/toggle-freeze", (req, res) => {
  const { cardNumber, frozen } = req.body;
  const users = readUsers();
  const user = users.find((u) => u.cardNumber === cardNumber);
  if (!user) return res.status(404).json({ error: "Kullanıcı yok" });
  user.frozen = frozen ? 1 : 0;
  writeUsers(users);

  // Admin tarafından dondurma bildirimi (tüm bağlı kullanıcılara)
  io.emit("notify", {
    title: "Hesap Donduruldu ❄️",
    body: `Admin tarafından ${user.name} donduruldu.`,
    icon: "/sounds/alert.png",
    sound: "/sounds/alert.mp3",
  });

  res.json({ success: true });
});
app.post("/api/admin/delete-user", (req, res) => {
  /* ... */
});
app.post("/api/admin/user-history", (req, res) => {
  /* ... */
});

// Static files
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// Socket.IO bağlantısı
io.on("connection", (socket) => {
  // İstemciden gelen 'join' ile ilgili kart numarasını alıp o oda'ya sokuyoruz
  socket.on("join", (cardNumber) => {
    socket.join(cardNumber);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server çalışıyor: http://0.0.0.0:${PORT}`);
});
const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const usersFile = "users.json";
const historyFile = "history.json";

// Helpers for reading/writing JSON files
function readUsers() {
  if (!fs.existsSync(usersFile)) return [];
  return JSON.parse(fs.readFileSync(usersFile, "utf8"));
}
function writeUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function readHistory() {
  if (!fs.existsSync(historyFile)) return {};
  return JSON.parse(fs.readFileSync(historyFile, "utf8"));
}
function writeHistory(history) {
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

// Get client IP (supports proxies)
function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "Bilinmiyor"
  );
}

// Admin kart numaraları
const adminCards = ["000000001"]; // Buraya kendi admin kart numaranızı ekleyin

// Rastgele 9 haneli kart numarası oluştur
function generateCardNumber() {
  const users = readUsers();
  let card;
  do {
    card = Math.floor(100000000 + Math.random() * 900000000).toString();
  } while (users.some((u) => u.cardNumber === card));
  return card;
}

// İşlem geçmişine kayıt ekler
function addHistory(cardNumber, entry) {
  const history = readHistory();
  if (!history[cardNumber]) history[cardNumber] = [];
  history[cardNumber].push(entry);
  writeHistory(history);
}

app.use(express.json());
app.use(express.static("public"));

// --- API ---

// Kart talep etme
app.post("/api/request-card", (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin || !/^\d{4}$/.test(pin)) {
    return res.json({ success: false, error: "Geçerli isim ve 4 haneli PIN giriniz." });
  }

  const users = readUsers();
  if (users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    return res.json({ success: false, error: "Bu isim zaten kayıtlı." });
  }

  const cardNumber = generateCardNumber();
  const ip = getClientIP(req);
  const createdAt = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });

  const newUser = {
    name,
    cardNumber,
    pin,
    password: pin, // Admin paneli için gösterilecek
    balance: 0,
    frozen: false,
    ip,
    createdAt,
    mode: "dark", // varsayılan modu "dark"
  };

  users.push(newUser);
  writeUsers(users);

  res.json({ success: true, cardNumber });
});

// Giriş yap
app.post("/api/login", (req, res) => {
  const { cardNumber, pin } = req.body;
  if (!cardNumber || !pin) {
    return res.json({ success: false, error: "Kart numarası ve PIN gerekli." });
  }

  const users = readUsers();
  const user = users.find((u) => u.cardNumber === cardNumber && u.pin === pin);
  if (!user) {
    return res.json({ success: false, error: "Geçersiz kart numarası veya PIN." });
  }

  // IP değişimi kontrolü ve bildirim gönder
  const oldIP = user.ip;
  const newIP = getClientIP(req);
  if (oldIP && oldIP !== newIP) {
    // Aynı hesaba farklı IP’den giriş bildirimi
    io.to(cardNumber).emit("notify", {
      title: "Dikkat!",
      body: `${user.name}, hesabına başka bir IP’den giriş yapıldı (${newIP}). Canlı desteğe danışın.`,
      icon: "/sounds/alert.png",
      sound: "/sounds/alert.mp3",
    });
  }

  user.ip = newIP;
  writeUsers(users);

  const history = readHistory();
  res.json({
    success: true,
    name: user.name,
    cardNumber: user.cardNumber,
    balance: user.balance,
    frozen: user.frozen || false,
    admin: adminCards.includes(cardNumber),
    history: history[cardNumber] || [],
    mode: user.mode, // kullanıcı modu dönüyoruz
  });
});

// Modu güncelleme (dark/light)
app.post("/api/set-mode", (req, res) => {
  const { cardNumber, mode } = req.body;
  if (!cardNumber || !["dark", "light"].includes(mode)) {
    return res.json({ success: false, error: "Geçersiz veri." });
  }
  const users = readUsers();
  const user = users.find((u) => u.cardNumber === cardNumber);
  if (!user) return res.json({ success: false, error: "Kullanıcı bulunamadı." });

  user.mode = mode;
  writeUsers(users);
  res.json({ success: true, mode });
});

// Para gönderme (kullanıcı adıyla, not destekli)
app.post("/api/send-money-by-name", (req, res) => {
  const { fromCard, toUsername, amount, note } = req.body;
  if (!fromCard || !toUsername || typeof amount !== "number" || amount <= 0) {
    return res.json({ success: false, error: "Geçersiz veri." });
  }

  const users = readUsers();
  const sender = users.find((u) => u.cardNumber === fromCard);
  const receiver = users.find((u) => u.name.toLowerCase() === toUsername.toLowerCase());

  if (!sender || sender.frozen) {
    return res.json({ success: false, error: "Gönderen hesabı geçersiz veya dondurulmuş." });
  }
  if (!receiver || receiver.frozen) {
    return res.json({ success: false, error: "Alıcı hesabı geçersiz veya dondurulmuş." });
  }
  if (sender.balance < amount) {
    return res.json({ success: false, error: "Yetersiz bakiye." });
  }

  sender.balance -= amount;
  receiver.balance += amount;
  writeUsers(users);

  const now = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  addHistory(fromCard, {
    type: "GÖNDERİLDİ",
    amount: -amount,
    to: receiver.name,
    date: now,
    note: note || "",
  });
  addHistory(receiver.cardNumber, {
    type: "ALINDI",
    amount: amount,
    from: sender.name,
    date: now,
    note: note || "",
  });

  // Notlu para gönderme bildirimi (not varsa gönder)
  if (note && note.trim() !== "") {
    io.to(receiver.cardNumber).emit("notify", {
      title: "Para Geldi 💰",
      body: `${sender.name} sana ${amount}₺ gönderdi.\nNot: ${note}`,
      icon: "/sounds/coin.png",
      sound: "/sounds/coin.mp3",
    });
  }

  const history = readHistory();
  res.json({ success: true, newBalance: sender.balance, history: history[fromCard] || [] });
});

// Hesap bilgilerini güncelle (isim ve/veya pin)
app.post("/api/update-account", (req, res) => {
  const { cardNumber, newName, newPin } = req.body;
  if (!cardNumber) return res.json({ success: false, error: "Kart numarası gerekli." });

  const users = readUsers();
  const user = users.find((u) => u.cardNumber === cardNumber);
  if (!user) return res.json({ success: false, error: "Kullanıcı bulunamadı." });

  // İsim değiştir
  if (newName && newName.trim() !== user.name) {
    if (users.some((u) => u.name.toLowerCase() === newName.toLowerCase())) {
      return res.json({ success: false, error: "Bu isim zaten kullanılıyor." });
    }
    user.name = newName.trim();
  }

  // PIN değiştir
  if (newPin) {
    if (!/^\d{4}$/.test(newPin)) {
      return res.json({ success: false, error: "PIN 4 haneli olmalı." });
    }
    user.pin = newPin;
    user.password = newPin; // admin panel için
  }

  writeUsers(users);
  res.json({ success: true, name: user.name });
});

// --- Admin API ---

app.get("/api/users", (req, res) => {
  const users = readUsers().map((u) => ({
    name: u.name,
    cardNumber: u.cardNumber,
    balance: u.balance,
    frozen: u.frozen,
    ip: u.ip,
    createdAt: u.createdAt,
    password: u.password,
    mode: u.mode,
  }));
  res.json(users);
});

app.post("/api/admin/reset-balance", (req, res) => {
  /* ... */
});
app.post("/api/admin/add-balance", (req, res) => {
  /* ... */
});
app.post("/api/admin/toggle-freeze", (req, res) => {
  const { cardNumber, frozen } = req.body;
  const users = readUsers();
  const user = users.find((u) => u.cardNumber === cardNumber);
  if (!user) return res.status(404).json({ error: "Kullanıcı yok" });
  user.frozen = frozen ? 1 : 0;
  writeUsers(users);

  // Admin tarafından dondurma bildirimi (tüm bağlı kullanıcılara)
  io.emit("notify", {
    title: "Hesap Donduruldu ❄️",
    body: `Admin tarafından ${user.name} donduruldu.`,
    icon: "/sounds/alert.png",
    sound: "/sounds/alert.mp3",
  });

  res.json({ success: true });
});
app.post("/api/admin/delete-user", (req, res) => {
  /* ... */
});
app.post("/api/admin/user-history", (req, res) => {
  /* ... */
});

// Static files
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// Socket.IO bağlantısı
io.on("connection", (socket) => {
  // İstemciden gelen 'join' ile ilgili kart numarasını alıp o oda'ya sokuyoruz
  socket.on("join", (cardNumber) => {
    socket.join(cardNumber);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server çalışıyor: http://0.0.0.0:${PORT}`);
});

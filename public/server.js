const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

const usersFile = "users.json";
const historyFile = "history.json";

// Helper: Dosyadan okuma ve yazma
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

// Admin kullanıcı kart numaraları (örnek)
const adminCards = ["000000001"]; // Buraya admin kart numarası ekle

// 9 haneli kart numarası oluştur
function generateCardNumber() {
  const users = readUsers();
  let card;
  do {
    card = Math.floor(100000000 + Math.random() * 900000000).toString();
  } while (users.find(u => u.cardNumber === card));
  return card;
}

// İşlem geçmişine kayıt ekle
function addHistory(cardNumber, entry) {
  const history = readHistory();
  if (!history[cardNumber]) history[cardNumber] = [];
  history[cardNumber].push(entry);
  writeHistory(history);
}

// --- API ---

// Kart talebi
app.post("/api/request-card", (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return res.json({ success: false, error: "Geçerli isim ve 4 haneli PIN giriniz." });
  }
  const users = readUsers();
  if (users.find(u => u.name.toLowerCase() === name.toLowerCase())) {
    return res.json({ success: false, error: "Bu isim zaten kayıtlı." });
  }
  const cardNumber = generateCardNumber();
  const newUser = {
    name,
    cardNumber,
    pin,
    balance: 0,
    frozen: false,
  };
  users.push(newUser);
  writeUsers(users);
  res.json({ success: true, cardNumber });
});

// Giriş yap
app.post("/api/login", (req, res) => {
  const { cardNumber, pin } = req.body;
  if (!cardNumber || !pin) return res.json({ success: false, error: "Kart numarası ve PIN gerekli." });

  const users = readUsers();
  const user = users.find(u => u.cardNumber === cardNumber && u.pin === pin);
  if (!user) return res.json({ success: false, error: "Geçersiz kart numarası veya PIN." });

  const history = readHistory();
  res.json({
    success: true,
    name: user.name,
    cardNumber: user.cardNumber,
    balance: user.balance,
    frozen: user.frozen || false,
    admin: adminCards.includes(cardNumber),
    history: history[cardNumber] || [],
  });
});

// Para gönderme (kullanıcı adına göre)
app.post("/api/send-money-by-name", (req, res) => {
  const { fromCard, toUsername, amount } = req.body;
  if (!fromCard || !toUsername || typeof amount !== "number" || amount <= 0) {
    return res.json({ success: false, error: "Geçersiz veri." });
  }

  const users = readUsers();
  const sender = users.find(u => u.cardNumber === fromCard);
  if (!sender) return res.json({ success: false, error: "Gönderen bulunamadı." });
  if (sender.frozen) return res.json({ success: false, error: "Hesabınız dondurulmuş." });

  const receiver = users.find(u => u.name.toLowerCase() === toUsername.toLowerCase());
  if (!receiver) return res.json({ success: false, error: "Alıcı bulunamadı." });
  if (receiver.frozen) return res.json({ success: false, error: "Alıcının hesabı dondurulmuş." });

  if (sender.balance < amount) return res.json({ success: false, error: "Yetersiz bakiye." });

  sender.balance -= amount;
  receiver.balance += amount;

  writeUsers(users);

  // İşlem geçmişi ekle
  addHistory(sender.cardNumber, { type: "GÖNDERİLDİ", amount: -amount, to: receiver.name, date: new Date().toLocaleString() });
  addHistory(receiver.cardNumber, { type: "ALINDI", amount: amount, from: sender.name, date: new Date().toLocaleString() });

  const history = readHistory();
  res.json({ success: true, newBalance: sender.balance, history: history[sender.cardNumber] || [] });
});

// --- Admin API ---

app.get("/api/users", (req, res) => {
  const users = readUsers().map(({ pin, ...keep }) => keep); // PIN gizle
  res.json(users);
});

app.post("/api/admin/reset-balance", (req, res) => {
  const { cardNumber } = req.body;
  if (!cardNumber) return res.status(400).json({ error: "Kart numarası gerekli" });

  const users = readUsers();
  const user = users.find(u => u.cardNumber === cardNumber);
  if (!user) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

  user.balance = 0;
  writeUsers(users);
  res.json({ success: true });
});

app.post("/api/admin/add-balance", (req, res) => {
  const { cardNumber, amount } = req.body;
  if (!cardNumber || typeof amount !== "number" || amount <= 0) return res.status(400).json({ error: "Geçersiz veri" });

  const users = readUsers();
  const user = users.find(u => u.cardNumber === cardNumber);
  if (!user) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

  user.balance += amount;
  writeUsers(users);
  res.json({ success: true });
});

app.post("/api/admin/toggle-freeze", (req, res) => {
  const { cardNumber, frozen } = req.body;
  if (!cardNumber || typeof frozen !== "boolean") return res.status(400).json({ error: "Geçersiz veri" });

  const users = readUsers();
  const user = users.find(u => u.cardNumber === cardNumber);
  if (!user) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

  user.frozen = frozen;
  writeUsers(users);
  res.json({ success: true });
});

app.post("/api/admin/delete-user", (req, res) => {
  const { cardNumber } = req.body;
  if (!cardNumber) return res.status(400).json({ error: "Kart numarası gerekli" });

  let users = readUsers();
  const initialLength = users.length;
  users = users.filter(u => u.cardNumber !== cardNumber);
  if (users.length === initialLength) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

  writeUsers(users);

  // İşlem geçmişinden de sil
  let history = readHistory();
  delete history[cardNumber];
  writeHistory(history);

  res.json({ success: true });
});

app.post("/api/admin/user-history", (req, res) => {
  const { cardNumber } = req.body;
  if (!cardNumber) return res.status(400).json({ error: "Kart numarası gerekli" });

  const history = readHistory();
  res.json({ history: history[cardNumber] || [] });
});

// Statik dosya admin ve index
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server çalışıyor: http://0.0.0.0:${PORT}`);
});

const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));
app.use(express.json());

const dbPath = "./users.json";

function readUsers() {
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify([]));
  return JSON.parse(fs.readFileSync(dbPath));
}

function writeUsers(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// Kart talep et
app.post("/api/request-card", (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin || pin.length !== 4) {
    return res.status(400).json({ error: "Geçersiz veri" });
  }

  const users = readUsers();
  let cardNumber;
  do {
    cardNumber = Math.floor(100000000 + Math.random() * 900000000).toString();
  } while (users.some((u) => u.cardNumber === cardNumber));

  const newUser = {
    name,
    pin,
    cardNumber,
    balance: 1000,
    history: []
  };

  users.push(newUser);
  writeUsers(users);
  res.json({ success: true, cardNumber });
});

// Giriş
app.post("/api/login", (req, res) => {
  const { cardNumber, pin } = req.body;
  const users = readUsers();
  const user = users.find(u => u.cardNumber === cardNumber && u.pin === pin);
  if (!user) return res.status(401).json({ error: "Hatalı kart ya da şifre" });

  res.json({
    success: true,
    name: user.name,
    balance: user.balance,
    history: user.history,
    cardNumber: user.cardNumber
  });
});

// Para gönderme
app.post("/api/send-money", (req, res) => {
  const { fromCard, toCard, amount } = req.body;
  const users = readUsers();
  const sender = users.find(u => u.cardNumber === fromCard);
  const receiver = users.find(u => u.cardNumber === toCard);
  const amt = parseFloat(amount);

  if (!sender || !receiver) return res.status(400).json({ error: "Kart bulunamadı" });
  if (sender.balance < amt || amt <= 0) return res.status(400).json({ error: "Yetersiz bakiye veya geçersiz tutar" });

  sender.balance -= amt;
  receiver.balance += amt;

  const now = new Date().toLocaleString();
  sender.history.push({ type: "GÖNDERİLDİ", to: receiver.name, amount: -amt, date: now });
  receiver.history.push({ type: "ALINDI", from: sender.name, amount: amt, date: now });

  writeUsers(users);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`✅ Turkish Express aktif http://localhost:${PORT}`));

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Tự động kết nối/tạo Database SQLite
const db = new sqlite3.Database('./anhuy_mart.db', (err) => {
  if (err) console.error('Lỗi kết nối DB:', err.message);
  else console.log('Đã kết nối Database SQLite: anhuy_mart.db');
});

// Tạo Bảng dữ liệu chuẩn hóa (Schema) - Sử dụng datetime('now', 'localtime') cho múi giờ địa phương
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE,
    name TEXT,
    unit TEXT,
    initial_stock INTEGER DEFAULT 0,
    price REAL DEFAULT 0,
    sell_price REAL DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    qty INTEGER,
    price REAL,
    sell_price REAL,
    supplier TEXT,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    qty INTEGER,
    price REAL,
    customer TEXT,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stocktakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    system_qty INTEGER,
    actual_qty INTEGER,
    diff_qty INTEGER,
    note TEXT,
    status TEXT DEFAULT 'adjusted',
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  )`);
});

// --- API ENDPOINTS ---

// 1. Lấy danh sách sản phẩm + Tồn kho thực tế (Có phân trang & tìm kiếm)
app.get('/api/products', (req, res) => {
  const search = req.query.search || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50; // Mặc định 50 SP/trang
  const offset = (page - 1) * limit;

  const sql = `
    SELECT 
      p.id, p.sku, p.name, p.unit, p.initial_stock, p.price, p.sell_price,
      COALESCE(SUM(pur.qty), 0) as total_purchased,
      COALESCE(SUM(s.qty), 0) as total_sold,
      COALESCE(SUM(st.diff_qty), 0) as total_adjusted,
      (p.initial_stock + COALESCE(SUM(pur.qty), 0) - COALESCE(SUM(s.qty), 0) + COALESCE(SUM(st.diff_qty), 0)) as current_stock
    FROM products p
    LEFT JOIN purchases pur ON p.id = pur.product_id
    LEFT JOIN sales s ON p.id = s.product_id
    LEFT JOIN stocktakes st ON p.id = st.product_id AND st.status = 'adjusted'
    WHERE p.name LIKE ? OR p.sku LIKE ?
    GROUP BY p.id
    LIMIT ? OFFSET ?
  `;

  db.all(sql, [`%${search}%`, `%${search}%`, limit, offset], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 2. API Nhập Hàng
app.post('/api/purchases', (req, res) => {
  const { productId, sku, name, unit, qty, price, sellPrice, supplier } = req.body;

  db.serialize(() => {
    let targetId = productId;

    const processPurchase = (prodId) => {
      // Cập nhật giá bán/giá nhập mới vào danh mục
      db.run(`UPDATE products SET price = ?, sell_price = ? WHERE id = ?`, [price, sellPrice, prodId]);

      // Thêm bản ghi nhập hàng kèm múi giờ hiện tại GMT+7
      db.run(
        `INSERT INTO purchases (product_id, qty, price, sell_price, supplier, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
        [prodId, qty, price, sellPrice, supplier],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: 'Nhập hàng thành công!', purchaseId: this.lastID });
        }
      );
    };

    if (productId === 'NEW') {
      db.run(
        `INSERT INTO products (sku, name, unit, price, sell_price) VALUES (?, ?, ?, ?, ?)`,
        [sku, name, unit, price, sellPrice],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          processPurchase(this.lastID);
        }
      );
    } else {
      processPurchase(productId);
    }
  });
});

// 3. API Xuất Hàng (Bán Hàng)
app.post('/api/sales', (req, res) => {
  const { productId, qty, price, customer } = req.body;

  db.run(
    `INSERT INTO sales (product_id, qty, price, customer, created_at) VALUES (?, ?, ?, ?, datetime('now', 'localtime'))`,
    [productId, qty, price, customer],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Xuất hàng thành công!', saleId: this.lastID });
    }
  );
});

// 4. API Kiểm Kê Kho
app.post('/api/stocktakes', (req, res) => {
  const { productId, systemQty, actualQty, diffQty, note } = req.body;

  db.run(
    `INSERT INTO stocktakes (product_id, system_qty, actual_qty, diff_qty, note, status, created_at) VALUES (?, ?, ?, ?, ?, 'adjusted', datetime('now', 'localtime'))`,
    [productId, systemQty, actualQty, diffQty, note],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Kiểm kê và cân bằng kho thành công!' });
    }
  );
});

// 5. API Lấy lịch sử nhập hàng
app.get('/api/purchases', (req, res) => {
  const sql = `
    SELECT pur.*, p.name as product_name, p.sku 
    FROM purchases pur
    LEFT JOIN products p ON pur.product_id = p.id
    ORDER BY pur.created_at DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 6. API Lấy lịch sử xuất hàng
app.get('/api/sales', (req, res) => {
  const sql = `
    SELECT s.*, p.name as product_name, p.sku 
    FROM sales s
    LEFT JOIN products p ON s.product_id = p.id
    ORDER BY s.created_at DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Lắng nghe cổng server (Duy nhất 1 đoạn)
app.listen(PORT, () => {
  console.log(`Server HKD An Huy Mart đang chạy tại: http://localhost:${PORT}`);
});
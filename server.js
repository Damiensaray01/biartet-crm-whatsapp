const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 4000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'Frontend', 'public')));

// 1. BASE DE DATOS SQLITE
const db = new sqlite3.Database('./contactos.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    apellido TEXT,
    telefono TEXT,
    estado TEXT DEFAULT 'Pendiente',
    observaciones TEXT DEFAULT '',
    fecha TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run("ALTER TABLE clientes ADD COLUMN observaciones TEXT DEFAULT ''", () => {});
  db.run("ALTER TABLE clientes ADD COLUMN fecha TEXT DEFAULT CURRENT_TIMESTAMP", () => {});
});

// 2. DETECCIÓN AUTOMÁTICA DEL NAVEGADOR EN WINDOWS
function obtenerRutaNavegador() {
  const rutas = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
  ];
  for (const r of rutas) {
    if (fs.existsSync(r)) return r;
  }
  return undefined;
}

// 3. WHATSAPP CLIENT
let qrActual = null;
let whatsappConectado = false;
let enProcesoEnvio = false;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './whatsapp_sesion' }),
  puppeteer: {
    headless: true,
    executablePath: obtenerRutaNavegador(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions']
  }
});

client.on('qr', async (qr) => {
  console.log('>>> Nuevo Código QR generado.');
  qrActual = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
  whatsappConectado = false;
});

client.on('ready', () => {
  console.log('>>> WhatsApp conectado correctamente.');
  whatsappConectado = true;
  qrActual = null;
});

client.on('authenticated', () => console.log('Sesión autenticada.'));
client.on('disconnected', () => {
  console.log('WhatsApp desconectado.');
  whatsappConectado = false;
  qrActual = null;
  client.initialize();
});

client.initialize();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatearTelefono(numero) {
  let limpio = String(numero).replace(/[^0-9]/g, '');
  if (limpio.startsWith('0')) {
    limpio = '58' + limpio.substring(1);
  }
  return `${limpio}@c.us`;
}

// 4. RUTAS
app.get('/api/whatsapp-status', (req, res) => {
  res.json({
    conectado: whatsappConectado,
    qr: qrActual,
    enviando: enProcesoEnvio
  });
});

app.get('/api/contactos', (req, res) => {
  db.all("SELECT * FROM clientes ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.delete('/api/contactos/:id', (req, res) => {
  db.run("DELETE FROM clientes WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/contactos/eliminar-masivo', (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: "No hay IDs" });
  const ph = ids.map(() => '?').join(',');
  db.run(`DELETE FROM clientes WHERE id IN (${ph})`, ids, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, eliminados: this.changes });
  });
});

app.delete('/api/contactos-todos', (req, res) => {
  db.run("DELETE FROM clientes", (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.put('/api/contactos/:id/estado', (req, res) => {
  const { id } = req.params;
  const { estado, observaciones } = req.body;
  db.run("UPDATE clientes SET estado = ?, observaciones = ? WHERE id = ?", [estado, observaciones || '', id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 5. IMPORTAR EXCEL (RECONOCE EL CINTILLO: Fecha de carga, Nº Portabilidad, Nombres, Apellidos)
app.post('/api/subir-excel', upload.single('archivoExcel'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta archivo' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const stmt = db.prepare("INSERT INTO clientes (fecha, telefono, nombre, apellido, estado, observaciones) VALUES (?, ?, ?, ?, 'Pendiente', '')");
    let count = 0;

    const fechaHoy = new Date().toISOString().split('T')[0];

    filas.forEach(f => {
      // Soporta los encabezados de tu cintillo exacto
      const fecha = f['Fecha de carga'] || f['Fecha'] || f['fecha'] || fechaHoy;
      const rawTel = f['Nº Portabilidad'] || f['N° Portabilidad'] || f['Portabilidad'] || f['Telefono'] || f['telefono'] || f['Celular'] || '';
      const telefono = String(rawTel).replace(/[^0-9]/g, '');
      const nombre = f['Nombres'] || f['Nombre'] || f['nombres'] || f['nombre'] || '';
      const apellido = f['Apellidos'] || f['Apellido'] || f['apellidos'] || f['apellido'] || '';

      if (telefono) {
        stmt.run(fecha, telefono, nombre, apellido);
        count++;
      }
    });

    stmt.finalize();
    fs.unlinkSync(req.file.path);
    res.json({ mensaje: `¡Éxito! Se cargaron ${count} contactos con el formato oficial.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. DESCARGAR EXCEL CON TU CINTILLO OFICIAL
app.get('/api/descargar-excel', (req, res) => {
  db.all("SELECT fecha, telefono, nombre, apellido, estado, observaciones FROM clientes ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const formateados = rows.map(r => ({
      'Fecha de carga': r.fecha || '',
      'N° Portabilidad': r.telefono || '',
      'Nombres': r.nombre || '',
      'Apellidos': r.apellido || '',
      'Estado': r.estado || 'Pendiente',
      'Observaciones': r.observaciones || ''
    }));

    const ws = XLSX.utils.json_to_sheet(formateados);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Base_Datos_BIARTET");

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Base_Datos_BIARTET.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  });
});

// 7. ENVÍO MASIVO REAL
app.post('/api/enviar-masivo', async (req, res) => {
  if (!whatsappConectado) return res.status(400).json({ error: "WhatsApp no está vinculado. Escanea el código QR." });
  if (enProcesoEnvio) return res.status(400).json({ error: "Ya hay una campaña en curso." });

  const { plantillaMensaje } = req.body;

  db.all("SELECT * FROM clientes WHERE estado = 'Pendiente'", async (err, clientes) => {
    if (err) return res.status(500).json({ error: err.message });
    if (clientes.length === 0) return res.json({ mensaje: "No hay clientes en estado 'Pendiente'." });

    enProcesoEnvio = true;
    res.json({ mensaje: `Iniciando envío a ${clientes.length} contactos.` });

    for (const c of clientes) {
      try {
        const texto = plantillaMensaje.replace('{nombre}', c.nombre).replace('{apellido}', c.apellido);
        const chatId = formatearTelefono(c.telefono);

        console.log(`[BIARTET ENVÍO REAL A ${chatId}]`);
        await client.sendMessage(chatId, texto);

        db.run("UPDATE clientes SET estado = 'Enviado' WHERE id = ?", [c.id]);
      } catch (e) {
        console.error(`Error enviando a ${c.telefono}:`, e.message);
        db.run("UPDATE clientes SET estado = 'Rechazado', observaciones = 'Fallo en envío / No existe' WHERE id = ?", [c.id]);
      }

      const delay = Math.floor(Math.random() * (20000 - 10000 + 1)) + 10000;
      await sleep(delay);
    }

    enProcesoEnvio = false;
  });
});

app.listen(PORT, () => console.log(`Servidor BIARTET activo en http://localhost:${PORT}`));
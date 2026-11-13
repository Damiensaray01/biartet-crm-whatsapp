const express = require('express');
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

// 1. BASE DE DATOS NATIVA EN JSON (SIN CONFLICTOS DE GLIBC O C++)
const DB_FILE = path.join(__dirname, 'contactos.json');

function leerContactos() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
    return [];
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function guardarContactos(lista) {
  fs.writeFileSync(DB_FILE, JSON.stringify(lista, null, 2), 'utf8');
}

// 2. DETECCIÓN AUTOMÁTICA DEL NAVEGADOR
function obtenerRutaNavegador() {
  if (process.platform === 'win32') {
    const rutasWin = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    ];
    for (const r of rutasWin) {
      if (fs.existsSync(r)) return r;
    }
  }
  return undefined; // En Linux/Render utiliza el Chromium descargado por Puppeteer
}

// 3. WHATSAPP CLIENT CON TIMEOUTS EXTENDIDOS (120 SEGUNDOS)
let qrActual = null;
let estadoWhatsApp = 'desconectado'; // 'desconectado' | 'sincronizando' | 'conectado'
let enProcesoEnvio = false;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './whatsapp_sesion' }),
  authTimeoutMs: 120000,    // 2 minutos para autenticación en la nube
  takeoverTimeoutMs: 120000,
  puppeteer: {
    headless: true,
    executablePath: obtenerRutaNavegador(),
    timeout: 120000,        // 2 minutos para que Puppeteer no se cierre antes de tiempo
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      '--window-size=1280,800'
    ]
  }
});

// Evento: Generación de QR
client.on('qr', async (qr) => {
  console.log('>>> Nuevo Código QR generado.');
  qrActual = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
  estadoWhatsApp = 'desconectado';
});

// Evento: Escaneado por el teléfono (Oculta el QR inmediatamente)
client.on('authenticated', () => {
  console.log('>>> ¡ESCANEADO CON ÉXITO! Sincronizando chats con el teléfono...');
  qrActual = null;
  estadoWhatsApp = 'sincronizando';
});

// Evento: Monitor de descarga de chats
client.on('loading_screen', (percent, message) => {
  console.log(`>>> CARGANDO CHATS: ${percent}% - ${message}`);
});

// Evento: WhatsApp 100% operativo
client.on('ready', () => {
  console.log('>>> ¡WHATSAPP 100% VINCULADO Y OPERATIVO!');
  estadoWhatsApp = 'conectado';
  qrActual = null;
});

// Evento: Desconexión
client.on('disconnected', (reason) => {
  console.log('WhatsApp desconectado:', reason);
  estadoWhatsApp = 'desconectado';
  qrActual = null;
  iniciarWhatsApp();
});

// Inicialización blindada: evita que el servidor Node se apague por micro-retrasos de red
function iniciarWhatsApp() {
  client.initialize().catch((err) => {
    console.error('Aviso de espera en WhatsApp (reintentando en segundo plano):', err.message);
  });
}

iniciarWhatsApp();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Normalizar números de teléfono (Venezuela u otros países a formato internacional)
function formatearTelefono(numero) {
  let limpio = String(numero).replace(/[^0-9]/g, '');
  if (limpio.startsWith('0')) {
    limpio = '58' + limpio.substring(1);
  }
  return `${limpio}@c.us`;
}

// 4. RUTAS DE LA API

// Estado en vivo de la conexión
app.get('/api/whatsapp-status', (req, res) => {
  res.json({
    estado: estadoWhatsApp,
    conectado: estadoWhatsApp === 'conectado',
    sincronizando: estadoWhatsApp === 'sincronizando',
    qr: qrActual,
    enviando: enProcesoEnvio
  });
});

// Obtener lista de clientes
app.get('/api/contactos', (req, res) => {
  const lista = leerContactos();
  res.json(lista.sort((a, b) => b.id - a.id));
});

// Eliminar un contacto individual
app.delete('/api/contactos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  let lista = leerContactos();
  lista = lista.filter(c => c.id !== id);
  guardarContactos(lista);
  res.json({ success: true });
});

// Eliminar contactos masivamente
app.post('/api/contactos/eliminar-masivo', (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: "No hay IDs" });

  const idsNum = ids.map(id => parseInt(id));
  let lista = leerContactos();
  const inicial = lista.length;
  lista = lista.filter(c => !idsNum.includes(c.id));
  guardarContactos(lista);

  res.json({ success: true, eliminados: inicial - lista.length });
});

// Vaciar toda la base de datos
app.delete('/api/contactos-todos', (req, res) => {
  guardarContactos([]);
  res.json({ success: true });
});

// Actualizar estado y observaciones del CRM
app.put('/api/contactos/:id/estado', (req, res) => {
  const id = parseInt(req.params.id);
  const { estado, observaciones } = req.body;
  let lista = leerContactos();
  const c = lista.find(item => item.id === id);
  if (c) {
    if (estado) c.estado = estado;
    if (observaciones !== undefined) c.observaciones = observaciones;
    guardarContactos(lista);
  }
  res.json({ success: true });
});

// 5. IMPORTAR EXCEL (RECONOCE EL CINTILLO OFICIAL)
app.post('/api/subir-excel', upload.single('archivoExcel'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta archivo' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const lista = leerContactos();

    let proximoId = lista.reduce((max, c) => c.id > max ? c.id : max, 0) + 1;
    const fechaHoy = new Date().toISOString().split('T')[0];
    let count = 0;

    filas.forEach(f => {
      const fecha = f['Fecha de carga'] || f['Fecha'] || f['fecha'] || fechaHoy;
      const rawTel = f['Nº Portabilidad'] || f['N° Portabilidad'] || f['Portabilidad'] || f['Telefono'] || f['telefono'] || f['Celular'] || '';
      const telefono = String(rawTel).replace(/[^0-9]/g, '');
      const nombre = f['Nombres'] || f['Nombre'] || f['nombres'] || f['nombre'] || '';
      const apellido = f['Apellidos'] || f['Apellido'] || f['apellidos'] || f['apellido'] || '';

      if (telefono) {
        lista.push({
          id: proximoId++,
          fecha: fecha,
          telefono: telefono,
          nombre: nombre,
          apellido: apellido,
          estado: 'Pendiente',
          observaciones: ''
        });
        count++;
      }
    });

    guardarContactos(lista);
    fs.unlinkSync(req.file.path);
    res.json({ mensaje: `¡Éxito! Se cargaron ${count} contactos correctamente.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. DESCARGAR EXCEL CON EL CINTILLO OFICIAL
app.get('/api/descargar-excel', (req, res) => {
  const lista = leerContactos();
  const formateados = lista.map(r => ({
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

// 7. ENVÍO MASIVO REAL CON PROTECCIÓN ANTI-BANEO
app.post('/api/enviar-masivo', async (req, res) => {
  if (estadoWhatsApp !== 'conectado') {
    return res.status(400).json({ error: "WhatsApp no está listo. Por favor espera a que se complete la conexión." });
  }
  if (enProcesoEnvio) {
    return res.status(400).json({ error: "Ya hay una campaña de envío en ejecución." });
  }

  const { plantillaMensaje } = req.body;
  let lista = leerContactos();
  const pendientes = lista.filter(c => c.estado === 'Pendiente');

  if (pendientes.length === 0) {
    return res.json({ mensaje: "No hay clientes en estado 'Pendiente'." });
  }

  enProcesoEnvio = true;
  res.json({ mensaje: `Iniciando envío seguro a ${pendientes.length} contactos.` });

  for (const c of pendientes) {
    try {
      const texto = plantillaMensaje.replace('{nombre}', c.nombre).replace('{apellido}', c.apellido);
      const chatId = formatearTelefono(c.telefono);

      console.log(`[BIARTET ENVÍO REAL A ${chatId}]`);
      await client.sendMessage(chatId, texto);

      c.estado = 'Enviado';
    } catch (e) {
      console.error(`Error enviando a ${c.telefono}:`, e.message);
      c.estado = 'Rechazado';
      c.observaciones = 'Fallo en envío o no tiene WhatsApp';
    }

    guardarContactos(lista);

    // Pausa aleatoria anti-baneo de 10 a 20 segundos
    const delay = Math.floor(Math.random() * (20000 - 10000 + 1)) + 10000;
    console.log(`Pausa de seguridad: ${delay / 1000}s...`);
    await sleep(delay);
  }

  enProcesoEnvio = false;
  console.log(">>> Campaña finalizada.");
});

// 8. INICIAR SERVIDOR
app.listen(PORT, () => console.log(`Servidor BIARTET activo en puerto ${PORT}`));
// server.js
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const cors = require('cors');
const cron = require('node-cron');
const { nanoid } = require('nanoid');
const { createClient } = require('@supabase/supabase-js');

// 🔧 Patch global fetch for Node.js 20+ (undici) compatibility
const { fetch: undiciFetch } = require('undici');
global.fetch = (url, options = {}) => {
  if (options.body && !options.duplex) {
    options.duplex = 'half';
  }
  return undiciFetch(url, options);
};

const app = express();
const upload = multer({ dest: 'uploads/' });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const OWNER = 'Mr. Hans / Hans Tech';

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve frontend dashboard

// Helper: build base URL from request (supports proxies)
function getSiteUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['host'];
  return `${proto}://${host}`;
}

// ─── Upload Endpoint ───────────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  const site = getSiteUrl(req);

  if (!file) {
    return res
      .status(400)
      .json({ error: 'No file uploaded', owner: OWNER, site });
  }

  const uid = nanoid(8);
  const path = `${uid}/${file.originalname}`;

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from('files')
    .upload(path, fs.createReadStream(file.path), {
      contentType: file.mimetype,
    });

  // Remove temp file
  fs.unlinkSync(file.path);

  if (uploadError) {
    return res
      .status(500)
      .json({ error: uploadError.message, owner: OWNER, site });
  }

  // Insert metadata
  const { error: dbError } = await supabase
    .from('files_meta')
    .insert([{ id: uid, filename: file.originalname, mimetype: file.mimetype }]);

  if (dbError) {
    return res
      .status(500)
      .json({ error: dbError.message, owner: OWNER, site });
  }

  // Success response
  return res.json({
    uid,
    download_url: `${site}/file/${uid}`,
    api_url: `${site}/api/${uid}`,
    expires_in_days: 10,
    owner: OWNER,
    site,
  });
});

// ─── File Metadata ────────────────────────────────────────────────────────────
app.get('/api/:uid', async (req, res) => {
  const { uid } = req.params;
  const site = getSiteUrl(req);

  const { data, error } = await supabase
    .from('files_meta')
    .select()
    .eq('id', uid)
    .single();

  if (error || !data) {
    return res
      .status(404)
      .json({ error: 'File not found', owner: OWNER, site });
  }

  return res.json({
    ...data,
    owner: OWNER,
    site,
    download_url: `${site}/file/${uid}`,
  });
});

// ─── File Download ────────────────────────────────────────────────────────────
app.get('/file/:uid', async (req, res) => {
  const { uid } = req.params;

  const { data, error } = await supabase
    .from('files_meta')
    .select()
    .eq('id', uid)
    .single();

  if (error || !data) {
    return res.status(404).send('File not found');
  }

  const { data: urlData } = await supabase.storage
    .from('files')
    .createSignedUrl(`${uid}/${data.filename}`, 60 * 10);

  if (!urlData?.signedUrl) {
    return res.status(500).send('Failed to generate download URL');
  }

  return res.redirect(urlData.signedUrl);
});

// ─── Dashboard Data ──────────────────────────────────────────────────────────
app.get('/dashboard-data', async (req, res) => {
  const site = getSiteUrl(req);

  const { data, error } = await supabase
    .from('files_meta')
    .select()
    .order('created_at', { ascending: false });

  if (error) {
    return res
      .status(500)
      .json({ error: 'Could not load dashboard', owner: OWNER, site });
  }

  return res.json({ files: data, owner: OWNER, site });
});

// ─── Cron Job: Delete Expired Files ────────────────────────────────────────────
cron.schedule('0 2 * * *', async () => {
  const { data, error } = await supabase
    .from('files_meta')
    .select('id, filename, created_at');

  if (error || !data) return;

  const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;

  for (const file of data) {
    if (new Date(file.created_at).getTime() < tenDaysAgo) {
      await supabase.storage.from('files').remove([`${file.id}/${file.filename}`]);
      await supabase.from('files_meta').delete().eq('id', file.id);
      console.log(`Deleted expired file: ${file.id}`);
    }
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🟢 Server running on port ${PORT}`);
});

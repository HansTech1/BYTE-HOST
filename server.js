// server.js
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { nanoid } = require('nanoid');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const OWNER = 'Mr. Hans / Hans Tech';

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // for dashboard frontend

// Helper to get site URL from request
function getSiteUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  const site = getSiteUrl(req);

  if (!file) return res.status(400).json({ error: 'No file uploaded', owner: OWNER, site });

  const uid = nanoid(8);
  const path = `${uid}/${file.originalname}`;

  const { error: uploadError } = await supabase.storage
    .from('files')
    .upload(path, fs.createReadStream(file.path), {
      contentType: file.mimetype,
    });

  fs.unlinkSync(file.path);

  if (uploadError) return res.status(500).json({ error: uploadError.message, owner: OWNER, site });

  const { error: dbError } = await supabase.from('files_meta').insert([
    {
      id: uid,
      filename: file.originalname,
      mimetype: file.mimetype,
    },
  ]);

  if (dbError) return res.status(500).json({ error: dbError.message, owner: OWNER, site });

  res.json({
    uid,
    download_url: `${site}/file/${uid}`,
    api_url: `${site}/api/${uid}`,
    expires_in_days: 10,
    owner: OWNER,
    site
  });
});

// File metadata
app.get('/api/:uid', async (req, res) => {
  const { uid } = req.params;
  const site = getSiteUrl(req);

  const { data, error } = await supabase
    .from('files_meta')
    .select()
    .eq('id', uid)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'File not found', owner: OWNER, site });
  }

  res.json({ ...data, owner: OWNER, site });
});

// File download
app.get('/file/:uid', async (req, res) => {
  const { uid } = req.params;

  const { data, error } = await supabase
    .from('files_meta')
    .select()
    .eq('id', uid)
    .single();

  if (error || !data) return res.status(404).send('File not found');

  const { data: fileUrl } = await supabase.storage
    .from('files')
    .createSignedUrl(`${uid}/${data.filename}`, 60 * 10);

  if (!fileUrl?.signedUrl) return res.status(404).send('Download failed');
  res.redirect(fileUrl.signedUrl);
});

// Public dashboard route
app.get('/dashboard-data', async (req, res) => {
  const site = getSiteUrl(req);

  const { data, error } = await supabase
    .from('files_meta')
    .select()
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Could not load dashboard', owner: OWNER, site });

  res.json({ files: data, owner: OWNER, site });
});

// Cron: delete files older than 10 days
cron.schedule('0 2 * * *', async () => {
  const { data, error } = await supabase
    .from('files_meta')
    .select('id, filename, created_at');

  if (error || !data) return;

  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

  for (const file of data) {
    if (new Date(file.created_at) < tenDaysAgo) {
      await supabase.storage.from('files').remove([`${file.id}/${file.filename}`]);
      await supabase.from('files_meta').delete().eq('id', file.id);
      console.log(`Deleted expired file: ${file.id}`);
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🟢 Server running on port ${PORT}`));

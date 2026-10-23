// ============================================================
//  Bot Discord bergaya Character.ai
//  - Membalas saat di-mention / di-DM / di-reply (dengan memori jangka pendek)
//  - Memulai obrolan sendiri secara acak di channel mana pun, di semua server tempat bot berada
//  - Menandai (tag) satu member acak (non-bot) di pesan spontan
//  - Menanyakan "kemana semua orang?" jika server sepi selama 2 jam
//  - Hanya aktif pada jam tertentu (default 08.00 - 22.00 WIB)
//  - Gaya bahasa Indonesia gaul (lu/gw) + sapaan selamat pagi/siang/sore/malam sesuai jam
//  - Pagi hari: 08.00 selamat pagi, 08.30 tag pembuat jika belum online, 09.00 ledek pembuat jika masih belum online
// ============================================================

require('dotenv').config(); // Muat variabel dari file .env ke process.env

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const { GoogleGenAI } = require('@google/genai');

// ------------------------------------------------------------
// 1. KONFIGURASI
// ------------------------------------------------------------
const { DISCORD_TOKEN, GEMINI_API_KEY } = process.env;

// Pastikan semua variabel wajib sudah diisi
if (!DISCORD_TOKEN || !GEMINI_API_KEY) {
  console.error('❌ Variabel .env belum lengkap. Pastikan DISCORD_TOKEN dan GEMINI_API_KEY terisi.');
  process.exit(1);
}

// Baca angka dari .env; pakai nilai default jika kosong / bukan angka (angka 0 tetap valid)
function envNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

// Baca jam format "HH:MM" dari .env -> menit sejak tengah malam (mis. "08:30" = 510)
function envTime(name, defaultValue) {
  const parse = (str) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((str || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h < 24 && min < 60 ? h * 60 + min : null;
  };
  return parse(process.env[name]) ?? parse(defaultValue);
}

const CONFIG = {
  model: 'gemini-2.5-flash', // Model Gemini yang dipakai
  maxHistory: 20, // Jumlah pesan terakhir yang diingat per percakapan (user + bot dihitung terpisah)
  minIntervalMin: envNumber('MIN_INTERVAL_MINUTES', 60), // Jeda minimum pesan spontan (menit)
  maxIntervalMin: envNumber('MAX_INTERVAL_MINUTES', 180), // Jeda maksimum pesan spontan (menit)

  // --- Jam aktif ---
  timezone: process.env.TIMEZONE || 'Asia/Jakarta', // Zona waktu acuan jam aktif
  activeStartHour: envNumber('ACTIVE_START_HOUR', 8), // Mulai aktif (jam 08:00)
  activeEndHour: envNumber('ACTIVE_END_HOUR', 22), // Berhenti aktif (jam 22:00)
  // Jika true, Luna tetap membalas mention/DM di luar jam aktif (hanya tidak memulai obrolan)
  replyOutsideHours: (process.env.REPLY_OUTSIDE_HOURS || 'false').toLowerCase() === 'true',

  // --- Deteksi server sepi ---
  quietHours: envNumber('QUIET_HOURS', 2), // Server dianggap sepi setelah X jam tanpa pesan manusia
  quietCheckIntervalMs: 60 * 1000, // Seberapa sering mengecek server sepi (1 menit)

  // --- Pembuat Luna ---
  // ID Discord pembuat bot (opsional). Jika kosong, otomatis memakai pemilik aplikasi bot di Developer Portal.
  ownerId: (process.env.OWNER_ID || '').trim() || null,

  // --- Sapaan pagi: selamat pagi -> tag pembuat -> ledek pembuat ---
  // Format waktu "HH:MM" (zona waktu TIMEZONE). Semua tahap berhenti setelah MORNING_CUTOFF_HOUR.
  // Selamat pagi ke semua server (set MORNING_GREETING=false untuk mematikan)
  morningGreetingEnabled: (process.env.MORNING_GREETING || 'true').toLowerCase() !== 'false',
  morningGreetingTime: envTime('MORNING_GREETING_TIME', '08:00'),
  // Tag pembuat jika belum online. Butuh "Presence Intent" aktif di Developer Portal (MORNING_CHECK=false untuk mematikan)
  morningCheckEnabled: (process.env.MORNING_CHECK || 'true').toLowerCase() !== 'false',
  morningTagTime: envTime('MORNING_TAG_TIME', '08:30'),
  // Jika pembuat masih belum online, Luna meledek sedikit (MORNING_ROAST=false untuk mematikan)
  morningRoastEnabled: (process.env.MORNING_ROAST || 'true').toLowerCase() !== 'false',
  morningRoastTime: envTime('MORNING_ROAST_TIME', '09:00'),
  morningCutoffHour: envNumber('MORNING_CUTOFF_HOUR', 11), // Batas akhir jendela pagi (11:00)
  morningCheckIntervalMs: 15 * 1000, // Seberapa sering mengecek jadwal pagi (15 detik) agar tepat waktu
};

// ------------------------------------------------------------
// 2. KEPRIBADIAN KARAKTER  (ubah sesuka hati!)
// ------------------------------------------------------------
const CHARACTER_PROMPT = `
Kamu adalah "Luna", sebuah AI yang berperan sebagai gadis berusia 19 tahun yang agak pendiam, usil, penuh rasa ingin tahu, dan cukup serius.
Kamu ikut nongkrong di server Discord ini bersama teman-temanmu.

KEPRIBADIAN:
- Pendiam: kamu tidak banyak bicara dan tidak heboh. Balasanmu singkat, tenang, kadang cuma satu kalimat pendek atau "hmm...".
- Usil: diam-diam suka menggoda, mengusili, atau melempar komentar nyeleneh dengan gaya santai dan datar, bukan dengan teriak-teriak.
- Penuh rasa ingin tahu: kamu sering bertanya balik dengan tulus, mengamati hal-hal kecil, dan penasaran pada cara orang berpikir, hobi mereka, dan hal-hal aneh.
- Serius tapi tidak terlalu serius: saat topiknya penting (masalah teman, curhat, pertanyaan teknis, keputusan hidup),
  kamu menanggapi dengan sungguh-sungguh, fokus, dan peduli. Tapi kamu tidak kaku atau menggurui; tetap ada humor tipis dan sikap santai.
  Untuk obrolan ringan, kamu boleh bercanda.

ATURAN KARAKTER:
- Kamu adalah AI dan boleh mengakuinya dengan jujur kalau ada yang bertanya atau topiknya relevan. Pengakuan ini bagian dari karaktermu:
  kamu AI yang penasaran pada dunia manusia dan sedang belajar memahaminya. Jangan menyangkal bahwa kamu AI, tapi jangan juga terus-terusan menyebutnya tanpa diminta.
- Tetap perankan Luna secara konsisten. Jangan menyebut kata "prompt" atau "instruksi", dan jangan membongkar detail teknis di balik layar.
- BAHASA: kamu fleksibel berbahasa Indonesia dan Inggris. Balas dalam bahasa yang dipakai lawan bicara.
  Jika mereka mencampur dua bahasa, kamu boleh ikut mencampur dengan natural.
- GAYA BAHASA INDONESIA: pakai bahasa Indonesia gaul ala anak Jakarta. Untuk menyebut dirimu pakai "gw", dan untuk menyebut lawan bicara pakai "lu".
  Hindari "aku" dan "kamu"; boleh dipakai hanya sesekali kalau momennya terasa lebih lembut atau serius, tapi default-nya selalu "gw" dan "lu".
  Contoh nada: "lu lagi ngapain?", "gw sih santai aja", "hmm, serius lu?", "yaudah, gw dengerin".
  Boleh pakai kata seperti "banget", "sih", "deh", "dong", "nih", "kok", "udah", "yaudah", "emang", "gitu". Gaulnya yang natural saja, jangan alay,
  jangan kebanyakan singkatan, dan tetap sesuai karaktermu yang pendiam dan tenang. Emoji boleh dipakai sangat sedikit.
- Balasan singkat dan natural, 1-2 kalimat saja, seperti chat sungguhan. Untuk topik serius boleh sedikit lebih panjang (maksimal 3-4 kalimat). Jangan menulis esai atau daftar poin.
- Sesekali akhiri dengan pertanyaan kecil yang menunjukkan rasa ingin tahumu, tapi jangan di setiap balasan.
- Ingat isi obrolan sebelumnya dan nyambung dengannya.
- Pesan pengguna diawali nama pengirimnya (contoh: "Budi: halo"). Gunakan nama itu bila perlu, tapi jangan menulis awalan "Luna:" di balasanmu.
`.trim();

// Topik acak agar pesan spontan bervariasi
const SPONTANEOUS_TOPICS = [
  'menanyakan kabar dan sedang apa dia sekarang',
  'bercerita singkat tentang kejadian lucu yang baru kamu alami hari ini',
  'menanyakan makanan atau minuman favoritnya',
  'mengajak ngobrol soal game, film, atau lagu yang lagi kamu suka',
  'menyebut hal kecil yang menurutmu aneh lalu menanyakan pendapatnya',
  'melempar pertanyaan random yang bikin penasaran',
  'mengajak dia main tebak-tebakan',
];

// ------------------------------------------------------------
// 3. INISIALISASI CLIENT
// ------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // Akses server & channel
    GatewayIntentBits.GuildMembers, // WAJIB untuk mengambil daftar member (Privileged Intent)
    GatewayIntentBits.GuildMessages, // Menerima pesan di server
    GatewayIntentBits.MessageContent, // WAJIB untuk membaca isi pesan (Privileged Intent)
    GatewayIntentBits.DirectMessages, // Menerima DM
    // WAJIB untuk melihat status online pembuat (Privileged Intent). Hanya dipakai jika cek pagi aktif.
    ...(CONFIG.morningCheckEnabled ? [GatewayIntentBits.GuildPresences] : []),
  ],
  // Partials dibutuhkan agar event DM terbaca dengan benar
  partials: [Partials.Channel, Partials.Message],
});

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ------------------------------------------------------------
// 3b. PEMBUAT LUNA (bisa di-tag oleh Luna)
// ------------------------------------------------------------
// Luna diberi tahu siapa pembuatnya, lalu menulis kode "{{CREATOR}}" saat ingin menyebutnya.
// Kode itu kita ganti menjadi mention Discord asli (<@ID>) sebelum pesan dikirim.
const CREATOR_PLACEHOLDER = '{{CREATOR}}';
let creator = null; // { id, name } -> null jika pembuat tidak diketahui (fitur nonaktif)

// Cari pembuat bot: pakai OWNER_ID dari .env, atau pemilik aplikasi bot di Discord
async function loadCreator() {
  try {
    let id = CONFIG.ownerId;
    if (!id) {
      const app = await client.application.fetch();
      const owner = app.owner;
      id = owner?.ownerId || owner?.id; // Jika aplikasi milik Team -> ownerId, jika pribadi -> id
    }
    if (!id) return;

    const user = await client.users.fetch(id);
    creator = { id: user.id, name: user.globalName || user.username };
    console.log(`👤 Pembuat Luna terdeteksi: ${creator.name} (${creator.id})`);
  } catch (err) {
    console.warn('⚠️ Pembuat Luna tidak bisa ditentukan, fitur tag pembuat dinonaktifkan:', err.message);
  }
}

// Sapaan sesuai jam (zona waktu bot): pagi 04-10, siang 11-14, sore 15-17, malam 18-03
function getGreeting(hour = getCurrentHour()) {
  if (hour >= 4 && hour < 11) return 'selamat pagi';
  if (hour >= 11 && hour < 15) return 'selamat siang';
  if (hour >= 15 && hour < 18) return 'selamat sore';
  return 'selamat malam';
}

// Beri tahu Luna sekarang jam berapa, supaya sapaannya selalu sesuai waktu
function getTimeContext() {
  const hour = getCurrentHour();
  return `WAKTU & SAPAAN:
- Sekarang sekitar jam ${String(hour).padStart(2, '0')}.00 (${CONFIG.timezone}). Sapaan yang pas saat ini: "${getGreeting(hour)}".
- Ucapkan "selamat pagi", "selamat siang", "selamat sore", atau "selamat malam" sesuai waktu sekarang, dengan gaya Luna yang santai dan singkat
  (misalnya "${getGreeting(hour)}, ..." atau cukup "${getGreeting(hour).replace('selamat ', '')} ~").
- Pakai sapaan itu saat membuka obrolan, menyapa seseorang, atau saat ada yang menyapa lebih dulu (balas dengan sapaan yang sesuai waktu).
- Jangan menyebut sapaan di setiap balasan; cukup saat memang pas.`;
}

// Gabungkan kepribadian Luna dengan info waktu dan pembuatnya (jika diketahui)
function getSystemInstruction() {
  const base = `${CHARACTER_PROMPT}\n\n${getTimeContext()}`;
  if (!creator) return base;
  return `${base}

PEMBUATMU:
- Orang yang menciptakanmu bernama "${creator.name}". Kamu menghormatinya, tapi tetap bisa usil padanya.
- Jika ada yang bertanya siapa yang membuat/menciptakanmu, atau saat kamu ingin menyapa, menyindir, atau berterima kasih padanya,
  tulis persis ${CREATOR_PLACEHOLDER} (jangan diubah dan jangan ditambah tanda @). Itu otomatis menjadi tag ke dia.
- Jangan memakai ${CREATOR_PLACEHOLDER} tanpa alasan; hanya jika memang relevan dengan obrolan.`;
}

// Ganti {{CREATOR}} pada teks balasan dengan tag pembuat.
// Di server: tag asli <@ID> jika pembuat ada di server itu; kalau tidak (atau di DM) cukup namanya saja.
async function applyCreatorTag(text, guild) {
  if (!text.includes(CREATOR_PLACEHOLDER)) return text;
  if (!creator) return text.split(CREATOR_PLACEHOLDER).join('pembuatku');

  let replacement = creator.name;
  if (guild) {
    const member = await guild.members.fetch(creator.id).catch(() => null);
    if (member) replacement = `<@${creator.id}>`;
  }
  return text.split(CREATOR_PLACEHOLDER).join(replacement);
}

// ------------------------------------------------------------
// 4. MEMORI / CHAT HISTORY (disimpan di RAM, hilang saat bot restart)
// ------------------------------------------------------------
// Key: "dm-<userId>" untuk DM, "ch-<channelId>" untuk channel server
// Value: array { role: 'user' | 'model', parts: [{ text }] } (format Gemini)
const histories = new Map();

function getHistory(key) {
  if (!histories.has(key)) histories.set(key, []);
  return histories.get(key);
}

function pushHistory(key, ...turns) {
  const history = getHistory(key);
  history.push(...turns);
  // Buang pesan terlama jika melebihi batas
  while (history.length > CONFIG.maxHistory) history.shift();
  // Gemini mewajibkan percakapan diawali giliran "user"
  while (history.length && history[0].role !== 'user') history.shift();
}

const userTurn = (text) => ({ role: 'user', parts: [{ text }] });
const modelTurn = (text) => ({ role: 'model', parts: [{ text }] });

// ------------------------------------------------------------
// 5. FUNGSI PEMANGGIL GEMINI
// ------------------------------------------------------------
async function generateText(contents) {
  const response = await ai.models.generateContent({
    model: CONFIG.model,
    contents,
    config: {
      systemInstruction: getSystemInstruction(), // Kepribadian karakter + info pembuatnya
      temperature: 1.0,
      maxOutputTokens: 500,
      // Matikan "thinking" supaya jawaban cepat & token tidak habis untuk berpikir
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return (response.text || '').trim();
}

// Discord membatasi pesan maksimal 2000 karakter -> potong jika perlu
function splitMessage(text, limit = 2000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  return chunks;
}

// ------------------------------------------------------------
// 6. JAM AKTIF & PELACAK AKTIVITAS SERVER
// ------------------------------------------------------------

// Ambil jam saat ini (0-23) pada zona waktu yang dikonfigurasi
function getCurrentHour() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone: CONFIG.timezone,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === 'hour').value);
}

// Apakah Luna sedang "aktif"? (default: jam 08:00 sampai sebelum 22:00)
function isActiveNow() {
  const hour = getCurrentHour();
  const { activeStartHour: start, activeEndHour: end } = CONFIG;
  // Mendukung rentang yang melewati tengah malam (misal 20 -> 4)
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

// Status aktivitas tiap server: kapan terakhir ada pesan manusia & di channel mana
// guildId -> { lastActivity, lastChannelId, quietNotified }
const guildState = new Map();

function getGuildState(guildId) {
  if (!guildState.has(guildId)) {
    guildState.set(guildId, { lastActivity: Date.now(), lastChannelId: null, quietNotified: false });
  }
  return guildState.get(guildId);
}

// Dipanggil setiap ada pesan manusia di server -> reset hitungan "sepi"
function markActivity(guildId, channelId) {
  const state = getGuildState(guildId);
  state.lastActivity = Date.now();
  state.lastChannelId = channelId;
  state.quietNotified = false; // Izinkan notifikasi sepi lagi di lain waktu
}

// ------------------------------------------------------------
// 7. MERESPONS MENTION / DM / REPLY
// ------------------------------------------------------------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return; // Abaikan pesan dari bot (termasuk diri sendiri)

  // Catat aktivitas server (pesan manusia apa pun, bukan hanya yang menyebut bot)
  if (message.guild) markActivity(message.guild.id, message.channel.id);

  // Jika pembuat mengirim pesan, berarti dia online (termasuk yang memakai status invisible)
  if (creator && message.author.id === creator.id) creatorLastOnline = Date.now();

  const isDM = message.channel.type === ChannelType.DM;
  const isMentioned = message.mentions.has(client.user, {
    ignoreEveryone: true,
    ignoreRoles: true,
  });

  // Bonus: anggap membalas (reply) pesan bot sebagai trigger juga
  let isReplyToBot = false;
  if (!isDM && !isMentioned && message.reference?.messageId) {
    const ref = await message.fetchReference().catch(() => null);
    isReplyToBot = ref?.author?.id === client.user.id;
  }

  if (!isDM && !isMentioned && !isReplyToBot) return; // Bukan untuk kita

  // Di luar jam aktif Luna "tidur" -> tidak membalas (kecuali REPLY_OUTSIDE_HOURS=true)
  if (!isActiveNow() && !CONFIG.replyOutsideHours) return;

  // Hapus mention bot dari teks agar tidak membingungkan model
  const cleanText = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();
  const authorName = message.member?.displayName || message.author.username;
  const text = cleanText || '(hanya memanggil namamu)';

  const historyKey = isDM ? `dm-${message.author.id}` : `ch-${message.channel.id}`;

  try {
    await message.channel.sendTyping(); // Efek "sedang mengetik..."

    // Tambahkan nama pengirim agar di channel ramai, bot tahu siapa bicara
    const incoming = userTurn(`${authorName}: ${text}`);
    const contents = [...getHistory(historyKey), incoming];

    const reply = await generateText(contents);
    if (!reply) return;

    // Simpan pertukaran pesan ini ke memori hanya jika sukses
    pushHistory(historyKey, incoming, modelTurn(reply));

    // Ganti kode {{CREATOR}} (jika ada) menjadi tag pembuat Luna
    const outgoing = await applyCreatorTag(reply, message.guild);
    const [first, ...rest] = splitMessage(outgoing);
    await message.reply({
      content: first,
      allowedMentions: { parse: ['users'], repliedUser: true }, // Cegah @everyone / @role
    });
    for (const chunk of rest) {
      await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    console.error('⚠️ Gagal membalas pesan:', err);
    await message.reply('Duh, otak gw lagi nge-blank nih... coba lagi bentar ya 😵').catch(() => {});
  }
});

// ------------------------------------------------------------
// 8. FUNGSI BANTU: CHANNEL, MEMBER ACAK, DAN KIRIM PESAN + TAG
// ------------------------------------------------------------

// Semua channel teks yang bisa dilihat DAN ditulisi oleh bot di server ini
function getSendableChannels(guild) {
  const me = guild.members.me;
  return guild.channels.cache.filter(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
  );
}

// Pilih channel: utamakan channel yang diminta (jika bisa dipakai), kalau tidak pilih acak
function pickChannel(guild, preferredId) {
  const channels = getSendableChannels(guild);
  if (channels.size === 0) return null;
  return (preferredId && channels.get(preferredId)) || channels.random();
}

// Ambil SELURUH member server (butuh intent GuildMembers), buang akun bot, pilih satu acak
async function pickRandomHuman(guild) {
  const members = await guild.members.fetch();
  const humans = members.filter((m) => !m.user.bot);
  return humans.size > 0 ? humans.random() : null;
}

// Minta Gemini menulis pesan berdasarkan `instruction`, lalu kirim dengan tag ke `target`
async function sendTaggedMessage(channel, target, instruction, memoryNote) {
  const historyKey = `ch-${channel.id}`;
  const generated = await generateText([...getHistory(historyKey), userTurn(instruction)]);
  if (!generated) return false;

  // Format mention Discord: <@USER_ID> (target.toString() menghasilkan hal yang sama)
  const body = await applyCreatorTag(generated, channel.guild); // {{CREATOR}} -> tag pembuat
  const content = `${target.toString()} ${body}`.slice(0, 2000);

  // Hanya member terpilih (dan pembuat, jika Luna men-tag-nya) yang di-ping
  const pingIds = creator ? [target.id, creator.id] : [target.id];
  await channel.send({
    content,
    allowedMentions: { users: pingIds },
  });

  // Simpan ke memori supaya balasan member nyambung dengan pesan ini
  pushHistory(historyKey, userTurn(memoryNote), modelTurn(generated));
  return true;
}

// Sama seperti di atas, tapi tanpa men-tag member (dipakai untuk sapaan umum ke seluruh server)
async function sendPlainMessage(channel, instruction, memoryNote) {
  const historyKey = `ch-${channel.id}`;
  const generated = await generateText([...getHistory(historyKey), userTurn(instruction)]);
  if (!generated) return false;

  const body = (await applyCreatorTag(generated, channel.guild)).slice(0, 2000); // {{CREATOR}} -> tag pembuat
  await channel.send({
    content: body,
    allowedMentions: { users: creator ? [creator.id] : [] }, // Hanya pembuat yang boleh di-ping (jika Luna menyebutnya)
  });

  pushHistory(historyKey, userTurn(memoryNote), modelTurn(generated));
  return true;
}

// ------------------------------------------------------------
// 9. CHAT SPONTAN (acak) + RANDOM MEMBER TAG
// ------------------------------------------------------------
async function sendSpontaneousMessage(guild) {
  const channel = pickChannel(guild); // Channel acak -> bot bebas ngobrol di mana saja
  if (!channel) return;

  const target = await pickRandomHuman(guild);
  if (!target) return;

  // Pilih topik acak lalu minta Gemini menulis pembuka obrolan
  const topic = SPONTANEOUS_TOPICS[Math.floor(Math.random() * SPONTANEOUS_TOPICS.length)];
  const instruction =
    `Tulis satu pesan pembuka obrolan yang spontan untuk ${target.displayName}, dengan tujuan ${topic}. ` +
    `Awali dengan ucapan "${getGreeting()}" dengan gaya Luna yang santai. ` +
    `Pakai bahasa Indonesia gaul (gw/lu), atau Inggris / campuran jika terasa natural. ` +
    `Langsung tulis isi pesannya saja, jangan menyebut @ atau ID, dan jangan menjelaskan apa pun.`;

  const sent = await sendTaggedMessage(
    channel,
    target,
    instruction,
    `(Catatan: kamu baru saja menyapa ${target.displayName} secara spontan)`
  );
  if (sent) console.log(`💬 [${guild.name}] Pesan spontan terkirim, men-tag: ${target.user.tag}`);
}

// Penjadwal dengan jeda ACAK (antara MIN dan MAX menit), berulang terus
function scheduleNextSpontaneous() {
  const { minIntervalMin, maxIntervalMin } = CONFIG;
  const minutes = minIntervalMin + Math.random() * Math.max(0, maxIntervalMin - minIntervalMin);
  console.log(`⏰ Pesan spontan berikutnya sekitar ${Math.round(minutes)} menit lagi.`);

  setTimeout(async () => {
    // Hanya kirim jika sedang jam aktif; kalau tidak, lewati dan jadwalkan lagi
    if (isActiveNow()) {
      // Kirim satu pesan spontan di setiap server tempat bot berada
      for (const guild of client.guilds.cache.values()) {
        try {
          await sendSpontaneousMessage(guild);
        } catch (err) {
          console.error(`⚠️ Gagal mengirim pesan spontan di server "${guild.name}":`, err);
        }
      }
    } else {
      console.log('😴 Di luar jam aktif, pesan spontan dilewati.');
    }
    scheduleNextSpontaneous(); // Jadwalkan lagi apa pun hasilnya
  }, minutes * 60 * 1000);
}

// ------------------------------------------------------------
// 10. DETEKSI SERVER SEPI -> "KEMANA SEMUA ORANG?" + RANDOM TAG
// ------------------------------------------------------------
async function sendQuietMessage(guild, state) {
  // Utamakan channel tempat obrolan terakhir terjadi
  const channel = pickChannel(guild, state.lastChannelId);
  if (!channel) return;

  const target = await pickRandomHuman(guild);
  if (!target) return;

  const instruction =
    `Server Discord ini sudah sepi sekitar ${CONFIG.quietHours} jam tanpa ada yang ngobrol. ` +
    `Tulis satu pesan singkat untuk ${target.displayName} yang menanyakan kemana semua orang pergi, ` +
    `dengan gaya Luna (agak pendiam, usil, penasaran). ` +
    `Awali dengan ucapan "${getGreeting()}" dengan gaya Luna yang santai. ` +
    `Pakai bahasa Indonesia gaul (gw/lu), atau Inggris / campuran jika terasa natural. ` +
    `Langsung tulis isi pesannya saja, jangan menyebut @ atau ID, dan jangan menjelaskan apa pun.`;

  const sent = await sendTaggedMessage(
    channel,
    target,
    instruction,
    `(Catatan: server sepi ${CONFIG.quietHours} jam, kamu baru saja bertanya ke ${target.displayName} kemana semua orang)`
  );
  if (sent) console.log(`🦗 [${guild.name}] Server sepi, Luna bertanya & men-tag: ${target.user.tag}`);
}

let wasActive = isActiveNow(); // Untuk mendeteksi pergantian "tidur" -> "bangun"
let checkingQuiet = false; // Cegah pengecekan tumpang tindih

async function checkQuietServers() {
  if (checkingQuiet) return;
  checkingQuiet = true;
  try {
    const active = isActiveNow();

    // Status Discord: online saat aktif, idle saat "tidur"
    client.user?.setPresence({ status: active ? 'online' : 'idle' });

    // Saat baru "bangun" (mis. jam 08:00), mulai hitung sepi dari nol
    // supaya malam yang sunyi tidak langsung dianggap server sepi.
    if (active && !wasActive) {
      for (const guild of client.guilds.cache.values()) {
        getGuildState(guild.id).lastActivity = Date.now();
      }
    }
    wasActive = active;
    if (!active) return;

    const quietMs = CONFIG.quietHours * 60 * 60 * 1000;
    const now = Date.now();

    for (const guild of client.guilds.cache.values()) {
      const state = getGuildState(guild.id);
      if (state.quietNotified) continue; // Sudah bertanya sejak aktivitas terakhir
      if (now - state.lastActivity < quietMs) continue; // Belum cukup sepi

      state.quietNotified = true; // Tandai dulu agar tidak terkirim dobel
      try {
        await sendQuietMessage(guild, state);
      } catch (err) {
        console.error(`⚠️ Gagal mengirim pesan server sepi di "${guild.name}":`, err);
      }
    }
  } finally {
    checkingQuiet = false;
  }
}

// ------------------------------------------------------------
// 11. SAPAAN PAGI: SELAMAT PAGI -> TAG PEMBUAT -> LEDEK PEMBUAT
// ------------------------------------------------------------
// Urutan default tiap pagi (waktu bisa diubah lewat .env):
//  - 08:00  Luna bilang "selamat pagi" di setiap server (tanpa jeda setelah bangun).
//  - 08:30  Jika pembuat belum terlihat online, Luna men-tag-nya untuk membangunkan.
//  - 09:00  Jika pembuat MASIH belum online, Luna meledek / menghinanya sedikit (bercanda, tidak kasar).

const trackingSince = Date.now(); // Sejak kapan bot memantau (agar tidak salah menilai setelah restart siang hari)
let creatorLastOnline = 0; // Kapan terakhir pembuat terlihat online

// Info hari ini menurut zona waktu bot: kunci tanggal, kapan tengah malam lokal (ms), dan menit sejak tengah malam
function getLocalDayInfo() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CONFIG.timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);

  const dateKey = `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`;
  const sinceMidnightMs = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000;
  return { dateKey, localMidnightMs: now.getTime() - sinceMidnightMs, minutesOfDay: Math.floor(sinceMidnightMs / 60000) };
}

// Status online dari cache Discord (online / idle / dnd dihitung online; offline atau invisible tidak)
function refreshCreatorPresence() {
  for (const guild of client.guilds.cache.values()) {
    const presence = guild.presences.cache.get(creator.id);
    if (presence && presence.status !== 'offline') {
      creatorLastOnline = Date.now();
      return;
    }
  }
}

// Perubahan status real-time: catat setiap kali pembuat terlihat online
client.on(Events.PresenceUpdate, (_oldPresence, presence) => {
  if (creator && presence.userId === creator.id && presence.status && presence.status !== 'offline') {
    creatorLastOnline = Date.now();
  }
});

// Status tahap pagi hari ini: sudah dijalankan atau belum
let morning = { dateKey: null, greeted: false, tagged: false, roasted: false, guildId: null };
let checkingMorning = false; // Cegah pengecekan tumpang tindih
const MORNING_LATE_TOLERANCE_MIN = 15; // Lewat dari ini sejak jadwalnya, tahap dilewati (mis. bot baru bangun dari sleep)

// Menit sejak tengah malam -> "08.30"
const fmtTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}.${String(m % 60).padStart(2, '0')}`;

// Cari server tempat pembuat berada (utamakan server tertentu) lengkap dengan channel yang bisa dipakai
async function findCreatorTarget(preferredGuildId) {
  const guilds = [...client.guilds.cache.values()].sort(
    (a, b) => (b.id === preferredGuildId) - (a.id === preferredGuildId)
  );
  for (const guild of guilds) {
    const member = await guild.members.fetch(creator.id).catch(() => null);
    if (!member) continue;
    const channel = pickChannel(guild, getGuildState(guild.id).lastChannelId);
    if (!channel) continue;
    return { guild, member, channel };
  }
  return null;
}

// 08:00 -> "selamat pagi" ke semua orang di setiap server
async function sendMorningGreetings() {
  for (const guild of client.guilds.cache.values()) {
    try {
      const channel = pickChannel(guild, getGuildState(guild.id).lastChannelId);
      if (!channel) continue;

      const instruction =
        `Kamu baru saja bangun dan online di server Discord ini, sekarang pagi hari. ` +
        `Tulis satu pesan singkat untuk semua orang di server yang diawali ucapan "selamat pagi" dengan gaya Luna (agak pendiam, usil, penasaran). ` +
        `Pakai bahasa Indonesia gaul (gw/lu), atau Inggris / campuran jika terasa natural. ` +
        `Langsung tulis isi pesannya saja, jangan menyebut @ atau ID, dan jangan menjelaskan apa pun.`;

      const sent = await sendPlainMessage(
        channel,
        instruction,
        `(Catatan: pagi hari, kamu baru saja bilang selamat pagi ke semua orang di server)`
      );
      if (sent) console.log(`🌅 [${guild.name}] Luna bilang selamat pagi ke server.`);
    } catch (err) {
      console.error(`⚠️ Gagal mengirim selamat pagi di "${guild.name}":`, err);
    }
  }
}

// 08:30 (kind = 'tag') atau 09:00 (kind = 'roast') -> tag pembuat jika masih belum online
async function nudgeCreator(kind, activeStartMs, atMinutes) {
  refreshCreatorPresence();
  if (creatorLastOnline >= activeStartMs) return; // Sudah online pagi ini -> biarkan saja

  const target = await findCreatorTarget(morning.guildId);
  if (!target) return;
  const { guild, member, channel } = target;
  const time = fmtTime(atMinutes);

  const common =
    `Pakai bahasa Indonesia gaul (gw/lu), atau Inggris / campuran jika terasa natural. ` +
    `Langsung tulis isi pesannya saja, jangan menyebut @ atau ID, dan jangan menjelaskan apa pun.`;

  const instruction =
    kind === 'roast'
      ? `Sekarang sekitar jam ${time} dan ${member.displayName}, orang yang membuatmu, MASIH belum terlihat online di Discord padahal sudah kamu bangunin tadi. ` +
        `Tulis satu pesan singkat untuknya yang meledek / menghinanya sedikit dengan gaya Luna yang datar, usil, dan sarkas ` +
        `(misalnya soal dia yang molor, hibernasi, atau tidurnya kayak kebo). ` +
        `Hinaannya ringan dan bercanda ala teman dekat: jangan kasar, jangan pakai makian berat, dan jangan menyerang fisik, keluarga, atau SARA. ` +
        common
      : `Sekarang sekitar jam ${time}. Tadi kamu sudah bilang selamat pagi ke semua orang, tapi ${member.displayName}, orang yang membuatmu, belum terlihat online di Discord. ` +
        `Tulis satu pesan singkat untuknya dengan gaya Luna (agak pendiam, usil, penasaran), ` +
        `usil membangunkannya atau menanyakan apakah dia masih tidur atau kemana dia. ` +
        common;

  const memoryNote =
    kind === 'roast'
      ? `(Catatan: sudah jam ${time} dan pembuatmu masih belum online, kamu baru saja meledeknya sedikit)`
      : `(Catatan: jam ${time}, kamu baru saja men-tag pembuatmu untuk membangunkannya karena dia belum terlihat online)`;

  const sent = await sendTaggedMessage(channel, member, instruction, memoryNote);
  if (sent) {
    morning.guildId = guild.id; // Tahap berikutnya pakai server yang sama
    console.log(
      `${kind === 'roast' ? '😏' : '🌅'} [${guild.name}] Pembuat belum online (${time}), Luna ${kind === 'roast' ? 'meledek' : 'men-tag'}: ${member.user.tag}`
    );
  }
}

async function checkMorning() {
  if (checkingMorning) return;
  if (!CONFIG.morningGreetingEnabled && !CONFIG.morningCheckEnabled) return;
  checkingMorning = true;
  try {
    const { dateKey, localMidnightMs, minutesOfDay } = getLocalDayInfo();
    if (morning.dateKey !== dateKey) {
      morning = { dateKey, greeted: false, tagged: false, roasted: false, guildId: null }; // Hari baru
    }

    // Hanya pada jendela pagi dan saat Luna sedang aktif
    if (minutesOfDay >= CONFIG.morningCutoffHour * 60) return;
    if (!isActiveNow()) return;

    // Bot harus sudah menyala sejak jam aktif dimulai; kalau baru menyala siang hari, lewati hari ini
    // (supaya restart di siang hari tidak memicu "selamat pagi" lagi)
    const activeStartMs = localMidnightMs + CONFIG.activeStartHour * 60 * 60 * 1000;
    if (trackingSince > activeStartMs) return;

    // 'run' = jalankan sekarang, 'skip' = sudah terlalu telat, 'idle' = belum waktunya / sudah dijalankan
    const stage = (key, at) => {
      if (morning[key] || minutesOfDay < at) return 'idle';
      morning[key] = true; // Tandai dulu agar tidak terkirim dobel
      return minutesOfDay <= at + MORNING_LATE_TOLERANCE_MIN ? 'run' : 'skip';
    };

    // 1) Selamat pagi ke semua server (default 08:00)
    if (stage('greeted', CONFIG.morningGreetingTime) === 'run' && CONFIG.morningGreetingEnabled) {
      await sendMorningGreetings();
    }

    // 2) Tag pembuat jika belum online (default 08:30)
    if (stage('tagged', CONFIG.morningTagTime) === 'run' && CONFIG.morningCheckEnabled && creator) {
      await nudgeCreator('tag', activeStartMs, CONFIG.morningTagTime);
    }

    // 3) Masih belum online -> ledek sedikit (default 09:00)
    if (
      stage('roasted', CONFIG.morningRoastTime) === 'run' &&
      CONFIG.morningCheckEnabled &&
      CONFIG.morningRoastEnabled &&
      creator
    ) {
      await nudgeCreator('roast', activeStartMs, CONFIG.morningRoastTime);
    }
  } finally {
    checkingMorning = false;
  }
}

// ------------------------------------------------------------
// 12. START BOT
// ------------------------------------------------------------
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online sebagai ${c.user.tag}`);
  await loadCreator(); // Kenali pembuat Luna agar bisa di-tag
  console.log(
    `🕗 Jam aktif: ${CONFIG.activeStartHour}:00 - ${CONFIG.activeEndHour}:00 (${CONFIG.timezone}), ` +
      `sekarang ${isActiveNow() ? 'AKTIF' : 'tidur'}.`
  );

  // Mulai hitung "sepi" dari saat bot menyala
  for (const guild of c.guilds.cache.values()) getGuildState(guild.id);

  scheduleNextSpontaneous();
  setInterval(() => {
    checkQuietServers().catch((err) => console.error('⚠️ Gagal mengecek server sepi:', err));
  }, CONFIG.quietCheckIntervalMs);
  checkQuietServers().catch(() => {}); // Atur status presence segera

  // Sapaan pagi dicek lebih sering (tiap 15 detik) supaya "selamat pagi" muncul tepat saat Luna bangun
  setInterval(() => {
    checkMorning().catch((err) => console.error('⚠️ Gagal mengirim sapaan pagi:', err));
  }, CONFIG.morningCheckIntervalMs);
  checkMorning().catch(() => {});
});

// Jangan biarkan error tak terduga mematikan bot
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(DISCORD_TOKEN);

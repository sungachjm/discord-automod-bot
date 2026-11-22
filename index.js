require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  ChannelType,
  MessageFlags,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
  AutoModerationRuleKeywordPresetType,
} = require('discord.js');

if (!process.env.TOKEN?.trim()) {
  console.error('❌ Thiếu biến môi trường: TOKEN');
  process.exit(1);
}
const { TOKEN, GUILD_ID, LOG_CHANNEL_ID } = process.env;

const COLOR = 0x2b2d31; // nhìn như "trong suốt" ở dark mode
const RED = 0xed4245;
const T = AutoModerationRuleTriggerType;
const A = AutoModerationActionType;

// Cấu hình lớp bảo vệ do bot tự xử lý (phần Discord AutoMod không có)
const FLOOD = { count: 6, seconds: 5, timeoutMs: 5 * 60_000 }; // 6 tin / 5 giây -> mute 5 phút
const STRIKE = { limit: 3, windowMs: 10 * 60_000, timeoutMs: 10 * 60_000 }; // 3 lần vi phạm / 10 phút -> mute 10 phút

// Tên các luật bot tạo (dùng để nhận ra luật của bot trong server)
const NAMES = {
  words: '[Bot] Từ cấm',
  invite: '[Bot] Chặn link mời Discord',
  mention: '[Bot] Spam mention',
  spam: '[Bot] Spam',
  preset: '[Bot] Ngôn từ nhạy cảm',
};
const LABELS = {
  words: 'Từ cấm',
  invite: 'Link mời Discord',
  mention: 'Spam mention',
  spam: 'Spam',
  preset: 'Ngôn từ nhạy cảm',
};
const INVITE_REGEX = '(?i)(?:discord\\.gg|discord(?:app)?\\.com/invite)/[a-z0-9-]+';

const client = new Client({
  // Không cần Message Content Intent: Discord tự lọc nội dung, bot chỉ đếm tin nhắn
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.AutoModerationExecution,
  ],
});

// ---------- Slash command definitions ----------
const ruleChoices = Object.entries(LABELS).map(([value, name]) => ({ name, value }));

const commands = [
  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Quản lý AutoMod')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Tạo hoặc cập nhật các luật AutoMod')
        .addChannelOption((o) =>
          o
            .setName('log_channel')
            .setDescription('Kênh nhận cảnh báo vi phạm')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addRoleOption((o) => o.setName('exempt_role').setDescription('Role được miễn AutoMod (staff)'))
        .addIntegerOption((o) =>
          o
            .setName('mention_limit')
            .setDescription('Số mention tối đa mỗi tin nhắn (mặc định 5)')
            .setMinValue(2)
            .setMaxValue(50),
        ),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Xem trạng thái các luật'))
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription('Bật hoặc tắt một luật')
        .addStringOption((o) =>
          o.setName('rule').setDescription('Luật cần chỉnh').setRequired(true).addChoices(...ruleChoices),
        )
        .addBooleanOption((o) => o.setName('enabled').setDescription('Bật (true) hay tắt (false)').setRequired(true)),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('words')
        .setDescription('Quản lý danh sách từ cấm')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Thêm từ cấm tạm (lâu dài hãy sửa badwords.txt)')
            .addStringOption((o) =>
              o.setName('words').setDescription('Các từ, ngăn cách bằng dấu phẩy (hỗ trợ *)').setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Xoá từ cấm tạm (lâu dài hãy sửa badwords.txt)')
            .addStringOption((o) =>
              o.setName('words').setDescription('Các từ cần xoá, ngăn cách bằng dấu phẩy').setRequired(true),
            ),
        )
        .addSubcommand((s) => s.setName('list').setDescription('Xem danh sách từ cấm (chỉ mình bạn thấy)'))
        .addSubcommand((s) => s.setName('sync').setDescription('Đồng bộ từ cấm từ file badwords.txt')),
    ),
].map((c) => c.toJSON());

// ---------- Helpers ----------
const ephemeral = { flags: MessageFlags.Ephemeral };
const parseWords = (s) => [
  ...new Set(
    (s ?? '')
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w && w.length <= 60),
  ),
];

function ruleSpecs({ alertChannelId, mentionLimit = 5 }) {
  const timeout = (sec) => ({ type: A.Timeout, metadata: { durationSeconds: sec } });
  const actions = (...extra) => [
    { type: A.BlockMessage, metadata: { customMessage: 'Tin nhắn của bạn vi phạm quy định của server.' } },
    ...(alertChannelId ? [{ type: A.SendAlertMessage, metadata: { channel: alertChannelId } }] : []),
    ...extra,
  ];
  return {
    words: { triggerType: T.Keyword, actions: actions(timeout(60)) },
    invite: {
      triggerType: T.Keyword,
      triggerMetadata: { regexPatterns: [INVITE_REGEX] },
      actions: actions(),
    },
    mention: {
      triggerType: T.MentionSpam,
      triggerMetadata: { mentionTotalLimit: mentionLimit, mentionRaidProtectionEnabled: true },
      actions: actions(timeout(300)),
    },
    spam: { triggerType: T.Spam, actions: actions() },
    preset: {
      triggerType: T.KeywordPreset,
      triggerMetadata: {
        presets: [
          AutoModerationRuleKeywordPresetType.Profanity,
          AutoModerationRuleKeywordPresetType.SexualContent,
          AutoModerationRuleKeywordPresetType.Slurs,
        ],
      },
      actions: actions(),
    },
  };
}

// Tìm kênh cảnh báo đã cấu hình trong các luật của bot
function alertChannelOf(rules) {
  for (const r of rules.values()) {
    if (!Object.values(NAMES).includes(r.name)) continue;
    const a = r.actions.find((x) => x.type === A.SendAlertMessage);
    if (a?.metadata?.channelId) return a.metadata.channelId;
  }
  return null;
}

const logChannelCache = new Map(); // guildId -> channelId
async function sendLog(guild, embed) {
  try {
    let id = LOG_CHANNEL_ID || logChannelCache.get(guild.id);
    if (!id) {
      id = alertChannelOf(await guild.autoModerationRules.fetch());
      if (id) logChannelCache.set(guild.id, id);
    }
    await guild.channels.cache.get(id)?.send({ embeds: [embed] });
  } catch (err) {
    console.error('Không gửi được log:', err.message);
  }
}

// ---------- File từ cấm (badwords.txt) ----------
const WORDS_FILE = path.join(__dirname, 'badwords.txt');

// Mỗi dòng một từ (hỗ trợ *), dòng bắt đầu bằng # là ghi chú
function loadWordsFile() {
  try {
    const lines = fs
      .readFileSync(WORDS_FILE, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'));
    return parseWords(lines.join(',')).slice(0, 1000);
  } catch {
    return [];
  }
}

// Lấy danh sách role được miễn từ một luật khác của bot
function exemptRolesOf(rules) {
  const ref = rules.find((r) => r.name !== NAMES.words && Object.values(NAMES).includes(r.name));
  return ref ? [...ref.exemptRoles.keys()] : [];
}

// Đồng bộ luật "Từ cấm" theo đúng nội dung file (file là nguồn chính)
async function syncWords(guild) {
  const words = loadWordsFile();
  if (!words.length) {
    return { message: 'file trống hoặc không đọc được, giữ nguyên danh sách hiện tại.' };
  }

  const rules = await guild.autoModerationRules.fetch();
  const rule = rules.find((r) => r.name === NAMES.words);

  if (!rule) {
    const spec = ruleSpecs({ alertChannelId: LOG_CHANNEL_ID || alertChannelOf(rules) }).words;
    await guild.autoModerationRules.create({
      name: NAMES.words,
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: spec.triggerType,
      triggerMetadata: { keywordFilter: words },
      actions: spec.actions,
      enabled: true,
      exemptRoles: exemptRolesOf(rules),
    });
    return { message: `đã tạo luật với ${words.length} từ.` };
  }

  const current = rule.triggerMetadata?.keywordFilter ?? [];
  const added = words.filter((w) => !current.includes(w)).length;
  const removed = current.filter((w) => !words.includes(w)).length;
  if (!added && !removed) return { message: `không đổi (${words.length} từ).` };

  await rule.edit({ triggerMetadata: { keywordFilter: words } });
  return { message: `+${added} thêm, -${removed} xoá, tổng ${words.length} từ.` };
}

// ---------- /automod setup ----------
async function setup(i) {
  await i.deferReply(ephemeral);
  const log = i.options.getChannel('log_channel', true);
  const exempt = i.options.getRole('exempt_role');
  const mentionLimit = i.options.getInteger('mention_limit') ?? 5;

  const specs = ruleSpecs({ alertChannelId: log.id, mentionLimit });
  const existing = await i.guild.autoModerationRules.fetch();
  const lines = [];

  for (const [key, spec] of Object.entries(specs)) {
    const name = NAMES[key];
    const current = existing.find((r) => r.name === name);
    try {
      if (current) {
        const patch = { actions: spec.actions, enabled: true };
        if (key !== 'words' && spec.triggerMetadata) patch.triggerMetadata = spec.triggerMetadata;
        if (exempt) patch.exemptRoles = [exempt.id];
        await current.edit(patch);
        lines.push(`🔄 ${LABELS[key]}: đã cập nhật`);
      } else if (key === 'words') {
        lines.push(`⏭️ ${LABELS[key]}: chưa có từ nào, dùng \`/automod words add\` để tạo`);
      } else {
        await i.guild.autoModerationRules.create({
          name,
          eventType: AutoModerationRuleEventType.MessageSend,
          triggerType: spec.triggerType,
          triggerMetadata: spec.triggerMetadata,
          actions: spec.actions,
          enabled: true,
          exemptRoles: exempt ? [exempt.id] : [],
        });
        lines.push(`✅ ${LABELS[key]}: đã tạo`);
      }
    } catch (err) {
      lines.push(`❌ ${LABELS[key]}: ${err.message}`);
    }
  }

  logChannelCache.set(i.guild.id, log.id);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Thiết lập AutoMod')
    .setDescription(lines.join('\n'))
    .addFields({ name: 'Kênh cảnh báo', value: `${log}` });
  return i.editReply({ embeds: [embed] });
}

// ---------- /automod status ----------
async function status(i) {
  await i.deferReply(ephemeral);
  const rules = await i.guild.autoModerationRules.fetch();
  const lines = Object.entries(NAMES).map(([key, name]) => {
    const r = rules.find((x) => x.name === name);
    if (!r) return `➖ ${LABELS[key]}: chưa tạo`;
    return `${r.enabled ? '✅' : '⛔'} ${LABELS[key]}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Trạng thái AutoMod')
    .setDescription(lines.join('\n'))
    .addFields(
      {
        name: 'Chống flood (bot xử lý)',
        value: `${FLOOD.count} tin trong ${FLOOD.seconds} giây → mute ${FLOOD.timeoutMs / 60_000} phút`,
      },
      {
        name: 'Vi phạm nhiều lần (bot xử lý)',
        value: `${STRIKE.limit} lần trong ${STRIKE.windowMs / 60_000} phút → mute ${STRIKE.timeoutMs / 60_000} phút`,
      },
    );
  return i.editReply({ embeds: [embed] });
}

// ---------- /automod toggle ----------
async function toggle(i) {
  await i.deferReply(ephemeral);
  const key = i.options.getString('rule', true);
  const enabled = i.options.getBoolean('enabled', true);
  const rules = await i.guild.autoModerationRules.fetch();
  const rule = rules.find((r) => r.name === NAMES[key]);
  if (!rule) return i.editReply(`❌ Luật "${LABELS[key]}" chưa được tạo. Chạy \`/automod setup\` trước nhé.`);
  await rule.setEnabled(enabled);
  return i.editReply(`${enabled ? '✅ Đã bật' : '⛔ Đã tắt'} luật **${LABELS[key]}**.`);
}

// ---------- /automod words ----------
async function wordsCmd(i, sub) {
  await i.deferReply(ephemeral);

  if (sub === 'sync') {
    const r = await syncWords(i.guild);
    return i.editReply(`📝 Đồng bộ \`badwords.txt\`: ${r.message}`);
  }

  const rules = await i.guild.autoModerationRules.fetch();
  const rule = rules.find((r) => r.name === NAMES.words);
  const current = rule?.triggerMetadata?.keywordFilter ?? [];

  if (sub === 'list') {
    if (!current.length) return i.editReply('Chưa có từ cấm nào.');
    return i.editReply(`**${current.length} từ cấm:**\n${current.join(', ').slice(0, 1800)}`);
  }

  const input = parseWords(i.options.getString('words', true));
  if (!input.length) {
    return i.editReply('❌ Không có từ hợp lệ (mỗi từ tối đa 60 ký tự, ngăn cách bằng dấu phẩy).');
  }

  if (sub === 'add') {
    const next = [...new Set([...current, ...input])];
    if (next.length > 1000) return i.editReply('❌ Tối đa 1000 từ cấm.');

    if (rule) {
      await rule.edit({ triggerMetadata: { keywordFilter: next } });
    } else {
      const spec = ruleSpecs({ alertChannelId: LOG_CHANNEL_ID || alertChannelOf(rules) }).words;
      await i.guild.autoModerationRules.create({
        name: NAMES.words,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: spec.triggerType,
        triggerMetadata: { keywordFilter: next },
        actions: spec.actions,
        enabled: true,
        exemptRoles: exemptRolesOf(rules),
      });
    }
    return i.editReply(`✅ Đã thêm ${input.length} từ. Tổng cộng ${next.length} từ cấm.`);
  }

  // remove
  if (!rule) return i.editReply('❌ Chưa có danh sách từ cấm.');
  const next = current.filter((w) => !input.includes(w));
  if (!next.length) {
    await rule.delete();
    return i.editReply('🗑️ Đã xoá hết từ cấm (luật được gỡ, thêm từ mới sẽ tạo lại).');
  }
  await rule.edit({ triggerMetadata: { keywordFilter: next } });
  return i.editReply(`✅ Đã xoá. Còn ${next.length} từ cấm.`);
}

// ---------- Chống flood (bot tự xử lý) ----------
const buckets = new Map(); // guildId:userId -> [{ ts, channelId, id }]

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (!msg.guild || msg.author.bot || !msg.member) return;
    if (msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return; // staff được miễn

    const key = `${msg.guildId}:${msg.author.id}`;
    const now = Date.now();
    const list = (buckets.get(key) ?? []).filter((m) => now - m.ts < FLOOD.seconds * 1000);
    list.push({ ts: now, channelId: msg.channelId, id: msg.id });
    buckets.set(key, list);
    if (list.length < FLOOD.count) return;

    buckets.delete(key);
    if (!msg.member.moderatable) return;
    await msg.member.timeout(FLOOD.timeoutMs, 'AutoMod: flood tin nhắn');

    // Xoá các tin vừa spam, gom theo kênh
    const byChannel = new Map();
    for (const m of list) byChannel.set(m.channelId, [...(byChannel.get(m.channelId) ?? []), m.id]);
    for (const [channelId, ids] of byChannel) {
      await msg.guild.channels.cache.get(channelId)?.bulkDelete(ids, true).catch(() => {});
    }

    await sendLog(
      msg.guild,
      new EmbedBuilder()
        .setColor(RED)
        .setTitle('Chống flood')
        .setDescription(`${msg.author} bị mute ${FLOOD.timeoutMs / 60_000} phút vì gửi quá nhiều tin nhắn.`)
        .setTimestamp(),
    );
  } catch (err) {
    console.error(err);
  }
});

// ---------- Vi phạm nhiều lần -> mute ----------
const strikes = new Map(); // guildId:userId -> [timestamps]

client.on(Events.AutoModerationActionExecution, async (exec) => {
  try {
    if (exec.action.type !== A.BlockMessage) return; // mỗi vi phạm chỉ tính một lần

    const key = `${exec.guild.id}:${exec.userId}`;
    const now = Date.now();
    const list = (strikes.get(key) ?? []).filter((t) => now - t < STRIKE.windowMs);
    list.push(now);
    if (list.length < STRIKE.limit) {
      strikes.set(key, list);
      return;
    }

    strikes.delete(key);
    const member = await exec.guild.members.fetch(exec.userId).catch(() => null);
    if (!member?.moderatable) return;
    await member.timeout(STRIKE.timeoutMs, 'AutoMod: vi phạm nhiều lần');

    await sendLog(
      exec.guild,
      new EmbedBuilder()
        .setColor(RED)
        .setTitle('Vi phạm nhiều lần')
        .setDescription(
          `${member} vi phạm ${STRIKE.limit} lần trong ${STRIKE.windowMs / 60_000} phút nên bị mute ${STRIKE.timeoutMs / 60_000} phút.`,
        )
        .setTimestamp(),
    );
  } catch (err) {
    console.error(err);
  }
});

// Dọn dữ liệu cũ trong bộ nhớ
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of buckets) {
    if (!list.some((m) => now - m.ts < FLOOD.seconds * 1000)) buckets.delete(k);
  }
  for (const [k, list] of strikes) {
    if (!list.some((t) => now - t < STRIKE.windowMs)) strikes.delete(k);
  }
}, 5 * 60_000).unref();

// ---------- Interactions ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'automod') return;
  try {
    if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return await i.reply({ content: '❌ Bạn cần quyền Manage Server.', ...ephemeral });
    }
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand();
    if (group === 'words') return await wordsCmd(i, sub);
    if (sub === 'setup') return await setup(i);
    if (sub === 'status') return await status(i);
    if (sub === 'toggle') return await toggle(i);
  } catch (err) {
    console.error(err);
    const payload = { content: `❌ Có lỗi xảy ra: ${err.message}` };
    if (i.deferred || i.replied) await i.editReply(payload).catch(() => {});
    else await i.reply({ ...payload, ...ephemeral }).catch(() => {});
  }
});

// ---------- Ready ----------
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Đăng nhập: ${c.user.tag}`);

  let guilds = [...c.guilds.cache.values()];
  if (GUILD_ID) {
    const guild = await c.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) {
      await guild.commands.set(commands);
      guilds = [guild];
    } else {
      console.error('❌ GUILD_ID sai hoặc bot chưa ở trong server đó.');
      guilds = [];
    }
  } else {
    await c.application.commands.set(commands);
  }
  console.log('📌 Đã đăng ký lệnh');

  // Tự đồng bộ từ cấm từ file badwords.txt mỗi lần bot khởi động
  for (const g of guilds) {
    try {
      const r = await syncWords(g);
      console.log(`📝 [${g.name}] từ cấm: ${r.message}`);
    } catch (err) {
      console.error(`❌ [${g.name}] không đồng bộ được từ cấm:`, err.message);
    }
  }
});

// Server HTTP nhỏ cho Render (cần cổng mở) và để UptimeRobot ping giữ bot thức
require('http')
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive');
  })
  .listen(process.env.PORT || 3000, () => console.log('🌐 HTTP server đang chạy'));

client.login(TOKEN);

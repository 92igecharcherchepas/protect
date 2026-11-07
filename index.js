require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
    ActionRowBuilder,
    AuditLogEvent,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    Client,
    ContainerBuilder,
    GatewayIntentBits,
    MessageFlags,
    PermissionsBitField,
    REST,
    RoleSelectMenuBuilder,
    Routes,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextDisplayBuilder,
} = require('discord.js');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'guilds.json');
const MODULES = [
    ['channelCreate', 'Création de salons'],
    ['channelDelete', 'Suppression de salons'],
    ['channelUpdate', 'Modification de salons'],
    ['roleCreate', 'Création de rôles'],
    ['roleDelete', 'Suppression de rôles'],
    ['roleUpdate', 'Modification de rôles'],
    ['rolePermissions', 'Permissions dangereuses'],
    ['roleDown', 'Déplacement de rôles/salons'],
    ['webhook', 'Webhooks'],
    ['thread', 'Fils de discussion'],
    ['guildUpdate', 'Modifications du serveur'],
    ['everyone', 'Mentions @everyone/@here'],
    ['botAdd', 'Ajout de bots'],
    ['ban', 'Bannissements'],
    ['kick', 'Expulsions'],
    ['timeout', 'Timeouts'],
    ['sensitiveRole', 'Rôles sensibles'],
    ['voiceMove', 'Déplacements vocaux'],
    ['voiceDisconnect', 'Déconnexions vocales'],
    ['voiceMute', 'Mutes micro'],
    ['voiceDeafen', 'Sourdines vocales'],
    ['spam', 'Spam'],
    ['links', 'Liens'],
];
const MODULE_NAMES = new Map(MODULES);
const COMPONENTS_V2_FLAGS = MessageFlags.IsComponentsV2;
const EPHEMERAL_V2_FLAGS = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;
const PANEL_COLOR = 0x808080;
const SANCTIONS = ['roles', 'kick', 'ban', 'tempban'];
const SANCTION_LABELS = {
    roles: 'Retrait des rôles',
    kick: 'Expulsion',
    ban: 'Bannissement',
    tempban: 'Exclusion temporaire (24 h)',
};
const DEFAULTS = {
    enabled: false,
    modules: Object.fromEntries(MODULES.map(([key]) => [key, false])),
    limits: Object.fromEntries(MODULES.map(([key]) => [key, 3])),
    windowSeconds: 10,
    sanction: 'roles',
    whitelist: {},
    owners: [],
    shield: [],
    accessRules: {},
    accessCategories: {},
    accessCooldowns: {},
    logs: {},
    tempBans: {},
};
const trackers = new Map();
const deletedSnapshots = new Map();
const pendingAuditEvents = new Set();
const pendingAccessCategories = new Map();
const envIds = (name) => (process.env[name] || '').split(',').map((id) => id.trim()).filter(Boolean);
const botOwners = new Set(envIds('PROTECT_OWNER_IDS'));
const buyers = new Set(envIds('PROTECT_BUYER_IDS'));

function readDatabase() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return {};
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Format de base de données invalide : ${DATA_FILE}`);
    }
    return parsed;
}

function writeDatabase(data) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temporaryFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temporaryFile, DATA_FILE);
}

function getConfig(guildId) {
    const database = readDatabase();
    const stored = database[guildId] || {};
    return {
        ...DEFAULTS,
        ...stored,
        modules: { ...DEFAULTS.modules, ...(stored.modules || {}) },
        limits: { ...DEFAULTS.limits, ...(stored.limits || {}) },
        whitelist: stored.whitelist || {},
        owners: stored.owners || [],
        shield: stored.shield || [],
        accessRules: stored.accessRules || {},
        accessCategories: stored.accessCategories || {},
        accessCooldowns: stored.accessCooldowns || {},
        logs: stored.logs || {},
        tempBans: stored.tempBans || {},
    };
}

function saveConfig(guildId, config) {
    const database = readDatabase();
    database[guildId] = config;
    writeDatabase(database);
}

function isBotOwner(userId) {
    return botOwners.has(userId);
}

function isGuildManager(interaction) {
    return isBotOwner(interaction.user.id) ||
        interaction.guild?.ownerId === interaction.user.id ||
        interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);
}

function canManageOwners(interaction) {
    return isBotOwner(interaction.user.id) || interaction.guild?.ownerId === interaction.user.id;
}

const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Ouvre le panneau de protection AntiRaid'),
    new SlashCommandBuilder().setName('limit').setDescription('Configure la limite d’un module')
        .addStringOption((option) => option.setName('module').setDescription('Module à configurer').setRequired(true)
            .addChoices(...MODULES.map(([value, name]) => ({ name, value }))))
        .addIntegerOption((option) => option.setName('nombre').setDescription('Actions autorisées avant sanction (1 à 20)')
            .setMinValue(1).setMaxValue(20).setRequired(true)),
    new SlashCommandBuilder().setName('on').setDescription('Active tous les modules AntiRaid'),
    new SlashCommandBuilder().setName('off').setDescription('Désactive tous les modules AntiRaid'),
    new SlashCommandBuilder().setName('info').setDescription('Informations AntiRaid')
        .addSubcommand((sub) => sub.setName('bypass').setDescription('Explique les niveaux de bypass')),
    new SlashCommandBuilder().setName('multi').setDescription('Configuration multiple')
        .addSubcommand((sub) => sub.setName('logs').setDescription('Crée/configure automatiquement le salon de logs')
            .addStringOption((option) => option.setName('module').setDescription('Module à journaliser').setRequired(true)
                .addChoices({ name: 'Tous les modules', value: 'all' },
                    ...MODULES.map(([value, name]) => ({ name, value }))))
            .addStringOption((option) => option.setName('serveur_id').setDescription('ID du serveur où créer le salon de logs').setRequired(true))),
    new SlashCommandBuilder().setName('owner').setDescription('Gère les owners AntiRaid')
        .addSubcommand((sub) => sub.setName('add').setDescription('Ajoute un owner')
            .addUserOption((option) => option.setName('membre').setDescription('Membre à ajouter').setRequired(true)))
        .addSubcommand((sub) => sub.setName('remove').setDescription('Retire un owner, même s’il a quitté')
            .addStringOption((option) => option.setName('id').setDescription('ID Discord').setRequired(true)))
        .addSubcommand((sub) => sub.setName('list').setDescription('Affiche les owners')),
    new SlashCommandBuilder().setName('shield').setDescription('Gère les membres protégés par Shield')
        .addSubcommand((sub) => sub.setName('add').setDescription('Protège un membre')
            .addUserOption((option) => option.setName('membre').setDescription('Membre à protéger').setRequired(true)))
        .addSubcommand((sub) => sub.setName('remove').setDescription('Retire un membre de Shield')
            .addUserOption((option) => option.setName('membre').setDescription('Membre').setRequired(true)))
        .addSubcommand((sub) => sub.setName('list').setDescription('Affiche la liste Shield')),
    new SlashCommandBuilder().setName('wl').setDescription('Gère la whitelist par module')
        .addSubcommand((sub) => sub.setName('add').setDescription('Whitelist un membre')
            .addUserOption((option) => option.setName('membre').setDescription('Membre').setRequired(true))
            .addStringOption((option) => option.setName('module').setDescription('Module ou tous')
                .setRequired(true).addChoices({ name: 'Tous les modules', value: 'all' },
                    ...MODULES.map(([value, name]) => ({ name, value })))))
        .addSubcommand((sub) => sub.setName('remove').setDescription('Retire un membre de la whitelist')
            .addUserOption((option) => option.setName('membre').setDescription('Membre').setRequired(true))
            .addStringOption((option) => option.setName('module').setDescription('Module ou tous')
                .setRequired(true).addChoices({ name: 'Tous les modules', value: 'all' },
                    ...MODULES.map(([value, name]) => ({ name, value })))))
        .addSubcommand((sub) => sub.setName('list').setDescription('Affiche la whitelist')),
    new SlashCommandBuilder().setName('acces').setDescription('Configure les pings spéciaux par catégorie')
        .addSubcommand((sub) => sub.setName('configurer').setDescription('Ouvre les menus de configuration'))
        .addSubcommand((sub) => sub.setName('retirer').setDescription('Retire la règle d’une catégorie')
            .addChannelOption((option) => option.setName('categorie').setDescription('Catégorie').setRequired(true)
                .addChannelTypes(ChannelType.GuildCategory)))
        .addSubcommand((sub) => sub.setName('liste').setDescription('Affiche les règles configurées')),
    new SlashCommandBuilder().setName('reset').setDescription('Réinitialise la configuration (buyer uniquement)'),
    new SlashCommandBuilder().setName('profil').setDescription('Modifie le profil global du bot (owner uniquement)')
        .addStringOption((option) => option.setName('nom').setDescription('Nouveau nom du bot').setMaxLength(80))
        .addStringOption((option) => option.setName('avatar').setDescription('URL HTTPS de l’avatar du bot'))
        .addStringOption((option) => option.setName('statut').setDescription('Texte affiché comme activité du bot').setMaxLength(128)),
].map((command) => command.toJSON());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

function recordAction(guildId, userId, moduleKey, config) {
    const key = `${guildId}:${userId}:${moduleKey}`;
    const now = Date.now();
    const windowMs = Math.max(1, config.windowSeconds) * 1000;
    const events = (trackers.get(key) || []).filter((time) => now - time <= windowMs);
    events.push(now);
    trackers.set(key, events);
    return events.length >= (config.limits[moduleKey] || 3);
}

function isBypassed(config, userId, moduleKey) {
    return botOwners.has(userId) || config.owners.includes(userId) ||
        (config.whitelist[userId] || []).some((item) => item === 'all' || item === moduleKey);
}

function isShielded(config, userId) {
    return config.shield.includes(userId);
}

function isLogChannel(channel) {
    return channel && channel.type === ChannelType.GuildText;
}

function hasLogPermissions(channel) {
    return channel.permissionsFor(client.user)?.has([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
    ]) || false;
}

function v2Payload(title, content, ephemeral = true) {
    const bodyLimit = Math.max(0, 3900 - title.length - 4);
    const body = String(content || '').slice(0, bodyLimit);
    const container = new ContainerBuilder()
        .setAccentColor(PANEL_COLOR)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## ${title}\n${body}`),
        );
    return {
        components: [container],
        flags: ephemeral ? EPHEMERAL_V2_FLAGS : COMPONENTS_V2_FLAGS,
    };
}

function replyV2(interaction, title, content) {
    return interaction.reply(v2Payload(title, content));
}

async function getOrCreateLogChannel(guild, config, moduleKey, usedChannelIds = new Set()) {
    const channelId = config.logs[moduleKey];
    if (channelId && !usedChannelIds.has(channelId)) {
        const channel = await client.channels.fetch(channelId).catch((error) => {
            if (error.code === 10003) return null;
            throw error;
        });
        if (channel?.guildId === guild.id) {
            if (!isLogChannel(channel)) {
                throw new Error(`Le salon de logs existant ${channelId} n’est pas un salon textuel valide.`);
            }
            if (!hasLogPermissions(channel)) {
                throw new Error(`Le bot n’a plus les permissions requises dans le salon de logs ${channelId}.`);
            }
            return { channel, created: false };
        }
    }

    const channelName = `antiraid-${moduleKey.toLowerCase()}`.slice(0, 100);
    const existingChannel = guild.channels.cache.find((candidate) =>
        candidate.name === channelName && isLogChannel(candidate) && !usedChannelIds.has(candidate.id));
    if (existingChannel) {
        if (!hasLogPermissions(existingChannel)) {
            throw new Error(`Le bot n’a plus les permissions requises dans le salon ${channelName}.`);
        }
        return { channel: existingChannel, created: false };
    }

    const botMember = await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        throw new Error(`Le bot doit avoir la permission Gérer les salons sur le serveur ${guild.id} pour créer le salon privé de logs.`);
    }

    const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `Salon privé de journaux AntiRaid : ${MODULE_NAMES.get(moduleKey)}.`,
        permissionOverwrites: [
            {
                id: guild.id,
                type: 0,
                deny: [PermissionsBitField.Flags.ViewChannel],
            },
            {
                id: client.user.id,
                type: 1,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.EmbedLinks,
                ],
            },
        ],
        reason: 'Création automatique du salon de logs Protect AntiRaid',
    });
    return { channel, created: true };
}

async function sendLog(guild, config, title, description, moduleKey = null) {
    const channelId = (moduleKey && config.logs[moduleKey]) || config.logs.general;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (!isLogChannel(channel)) {
        throw new Error(`Le salon de logs configuré (${channelId}) n’est pas un salon textuel de serveur.`);
    }
    if (!hasLogPermissions(channel)) {
        throw new Error(`Le bot n’a pas les permissions Voir le salon, Envoyer des messages et Intégrer des liens dans le salon de logs ${channelId}.`);
    }
    const container = new ContainerBuilder()
        .setAccentColor(PANEL_COLOR)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## ${title}\n${description}\n\n-# Serveur protégé : ${guild.name} · <t:${Math.floor(Date.now() / 1000)}:F>`,
            ),
        );
    await channel.send({ components: [container], flags: COMPONENTS_V2_FLAGS });
}

async function applySanction(member, config, reason) {
    if (!member || !member.manageable) return 'Impossible : membre au-dessus du bot ou permissions insuffisantes';
    switch (config.sanction) {
        case 'kick':
            await member.kick(reason);
            return 'Expulsion';
        case 'ban':
            await member.ban({ reason });
            return 'Bannissement';
        case 'tempban': {
            const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
            await member.ban({ reason });
            config.tempBans[member.id] = expiresAt;
            saveConfig(member.guild.id, config);
            scheduleUnban(member.guild, member.id, expiresAt);
            return 'Exclusion temporaire (24 h)';
        }
        case 'roles':
        default: {
            const roles = member.roles.cache.filter((role) => role.id !== member.guild.id && role.editable);
            if (roles.size) await member.roles.remove(roles, reason);
            return `Retrait de ${roles.size} rôle(s)`;
        }
    }
}

function scheduleUnban(guild, userId, expiresAt) {
    const delay = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(async () => {
        try {
            await guild.bans.remove(userId, 'Fin de l’exclusion temporaire AntiRaid');
            const config = getConfig(guild.id);
            delete config.tempBans[userId];
            saveConfig(guild.id, config);
        } catch (error) {
            if (error.code !== 10026) console.error(`[AntiRaid] Échec du débannissement ${userId}:`, error);
        }
    }, Math.min(delay, 2_147_000_000));
    timer.unref?.();
}

async function punish(guild, config, moduleKey, executorId, detail, targetMember = null, rollback = null, protectedTargetId = null) {
    if (!config.enabled || !config.modules[moduleKey] || isBypassed(config, executorId, moduleKey)) return;
    if (rollback) {
        try {
            await rollback();
        } catch (error) {
            console.error(`[AntiRaid] Restauration impossible (${moduleKey}, ${guild.id}):`, error);
        }
    }

    const shieldedId = targetMember?.id || protectedTargetId;
    if (shieldedId && isShielded(config, shieldedId)) {
        await sendLog(guild, config, 'Action bloquée sur Shield', `<@${executorId}> a ciblé <@${shieldedId}> (${MODULE_NAMES.get(moduleKey)}).`, moduleKey);
        return;
    }

    if (!recordAction(guild.id, executorId, moduleKey, config)) {
        await sendLog(guild, config, 'Action surveillée', `<@${executorId}> — ${MODULE_NAMES.get(moduleKey)}\n${detail}`, moduleKey);
        return;
    }

    let sanction = 'Sanction impossible';
    try {
        const member = await guild.members.fetch(executorId);
        if (moduleKey === 'roleDown') {
            const roles = member.roles.cache.filter((role) =>
                role.editable && role.permissions.has(PermissionsBitField.Flags.ManageRoles));
            for (const role of roles.values()) {
                await role.setPermissions(
                    role.permissions.remove(PermissionsBitField.Flags.ManageRoles),
                    'AntiRaid : déplacement répété de rôles/salons',
                );
            }
            sanction = `Permission Gérer les rôles retirée de ${roles.size} rôle(s)`;
        } else {
            sanction = await applySanction(member, config, `AntiRaid : ${MODULE_NAMES.get(moduleKey)}`);
        }
    } catch (error) {
        console.error(`[AntiRaid] Sanction impossible pour ${executorId}:`, error);
    }
    await sendLog(guild, config, '🚨 Protection AntiRaid déclenchée',
        `<@${executorId}> — **${MODULE_NAMES.get(moduleKey)}**\n${detail}\n**Sanction :** ${sanction}`, moduleKey);
}

async function auditEntryFor(guild, event, targetId, predicate = () => true) {
    const logs = await guild.fetchAuditLogs({ type: event, limit: 6 });
    return logs.entries.find((entry) =>
        (!targetId || entry.targetId === targetId) &&
        Date.now() - entry.createdTimestamp < 15_000 &&
        entry.executorId && entry.executorId !== client.user.id && predicate(entry));
}

async function handleAuditEntry(entry, guild) {
    if (!entry.executorId || entry.executorId === client.user.id) return;
    const action = entry.action;
    const targetId = entry.targetId;
    const roleSnapshot = deletedSnapshots.get(`role:${targetId}`);
    const channelSnapshot = deletedSnapshots.get(`channel:${targetId}`);
    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    let moduleKey = null;
    let rollback = null;
    let detail = `Action Discord ${action} sur ${targetId || 'le serveur'}.`;

    if (action === AuditLogEvent.ChannelCreate) {
        moduleKey = 'channelCreate';
        const channel = guild.channels.cache.get(targetId);
        rollback = channel ? () => channel.delete('AntiRaid : création non autorisée') : null;
    } else if (action === AuditLogEvent.ChannelDelete) {
        moduleKey = 'channelDelete';
        rollback = channelSnapshot ? () => restoreChannel(guild, channelSnapshot) : null;
    } else if (action === AuditLogEvent.ChannelUpdate) {
        moduleKey = 'channelUpdate';
    } else if (action === AuditLogEvent.RoleCreate) {
        moduleKey = 'roleCreate';
        const role = guild.roles.cache.get(targetId);
        rollback = role ? () => role.delete('AntiRaid : création non autorisée') : null;
    } else if (action === AuditLogEvent.RoleDelete) {
        moduleKey = 'roleDelete';
        rollback = roleSnapshot ? () => restoreRole(guild, roleSnapshot) : null;
    } else if (action === AuditLogEvent.RoleUpdate) {
        moduleKey = 'roleUpdate';
    } else if ([AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete, AuditLogEvent.WebhookUpdate].includes(action)) {
        moduleKey = 'webhook';
    } else if ([AuditLogEvent.ThreadCreate, AuditLogEvent.ThreadDelete, AuditLogEvent.ThreadUpdate].includes(action)) {
        moduleKey = 'thread';
    } else if (action === AuditLogEvent.GuildUpdate) {
        moduleKey = 'guildUpdate';
        const changes = entry.changes || [];
        rollback = async () => {
            const oldState = {};
            const fields = {
                name: 'name',
                verification_level: 'verificationLevel',
                explicit_content_filter: 'explicitContentFilter',
                default_message_notifications: 'defaultMessageNotifications',
                afk_timeout: 'afkTimeout',
                system_channel_id: 'systemChannel',
                rules_channel_id: 'rulesChannel',
                public_updates_channel_id: 'publicUpdatesChannel',
                preferred_locale: 'preferredLocale',
            };
            for (const change of changes) {
                if (fields[change.key]) oldState[fields[change.key]] = change.old ?? null;
            }
            if (Object.keys(oldState).length) await guild.edit(oldState, 'AntiRaid : restauration du serveur');
        };
    } else if (action === AuditLogEvent.BotAdd) {
        moduleKey = 'botAdd';
        const bot = targetMember;
        rollback = bot ? () => bot.kick('AntiRaid : ajout de bot non autorisé') : null;
    } else if (action === AuditLogEvent.MemberBanAdd) {
        moduleKey = 'ban';
        rollback = targetId ? () => guild.bans.remove(targetId, 'AntiRaid : bannissement annulé') : null;
    } else if (action === AuditLogEvent.MemberKick) {
        moduleKey = 'kick';
    } else if (action === AuditLogEvent.MemberUpdate) {
        const timeoutChange = entry.changes?.find((change) => change.key === 'communication_disabled_until');
        if (timeoutChange) {
            moduleKey = 'timeout';
            rollback = targetMember
                ? () => {
                    const expiresAt = timeoutChange.old ? Date.parse(timeoutChange.old) : 0;
                    return targetMember.timeout(Math.max(0, expiresAt - Date.now()), 'AntiRaid : restauration du timeout');
                }
                : null;
        }
    } else if (action === AuditLogEvent.MemberRoleUpdate) {
        const addedRoleIds = (entry.changes?.find((change) => change.key === '$add')?.new || [])
            .map((role) => role.id);
        const sensitivePermissions =
            PermissionsBitField.Flags.Administrator |
            PermissionsBitField.Flags.ManageGuild |
            PermissionsBitField.Flags.ManageRoles |
            PermissionsBitField.Flags.BanMembers |
            PermissionsBitField.Flags.KickMembers;
        const sensitiveRoleIds = addedRoleIds.filter((id) =>
            guild.roles.cache.get(id)?.permissions.has(sensitivePermissions));
        if (sensitiveRoleIds.length) {
            moduleKey = 'sensitiveRole';
            rollback = targetMember
                ? () => targetMember.roles.remove(sensitiveRoleIds, 'AntiRaid : retrait de rôles sensibles')
                : null;
        }
    } else if ([AuditLogEvent.MemberMove, AuditLogEvent.MemberDisconnect].includes(action)) {
        moduleKey = action === AuditLogEvent.MemberMove ? 'voiceMove' : 'voiceDisconnect';
    }
    if (!moduleKey) return;

    const config = getConfig(guild.id);
    if (action === AuditLogEvent.RoleUpdate) {
        const roleChanges = entry.changes || [];
        const role = guild.roles.cache.get(targetId);
        const permissionChanged = roleChanges.some((change) => change.key === 'permissions');
        const positionChange = roleChanges.find((change) => change.key === 'position');
        if (role && roleChanges.length) {
            rollback = async () => {
                const oldState = {};
                for (const change of roleChanges) {
                    if (change.key === 'permissions') oldState.permissions = BigInt(change.old || '0');
                    if (change.key === 'name') oldState.name = change.old;
                    if (change.key === 'color') oldState.color = change.old;
                    if (change.key === 'hoist') oldState.hoist = change.old;
                    if (change.key === 'mentionable') oldState.mentionable = change.old;
                }
                if (Object.keys(oldState).length) await role.edit(oldState, 'AntiRaid : restauration du rôle');
                if (positionChange) await role.setPosition(positionChange.old);
            };
        }
        if (permissionChanged && config.modules.rolePermissions) moduleKey = 'rolePermissions';
        if (positionChange) moduleKey = 'roleDown';
    }
    if (action === AuditLogEvent.ChannelUpdate) {
        const changes = entry.changes || [];
        const hasPositionChange = changes.some((change) => change.key === 'position');
        if (hasPositionChange) moduleKey = 'roleDown';
        const channel = guild.channels.cache.get(targetId);
        if (channel) {
            const oldPosition = changes.find((change) => change.key === 'position')?.old;
            rollback = async () => {
                const oldState = {};
                for (const change of changes) {
                    if (change.key === 'name') oldState.name = change.old;
                    if (change.key === 'topic') oldState.topic = change.old;
                    if (change.key === 'nsfw') oldState.nsfw = change.old;
                    if (change.key === 'rate_limit_per_user') oldState.rateLimitPerUser = change.old;
                }
                if (Object.keys(oldState).length) await channel.edit(oldState, 'AntiRaid : restauration du salon');
                if (oldPosition !== undefined) await channel.setPosition(oldPosition);
            };
        }
    }
    const description = `${detail}${entry.executorId ? `\n**Auteur :** <@${entry.executorId}>` : ''}`;
    await punish(guild, config, moduleKey, entry.executorId, description, targetMember, rollback,
        ['ban', 'kick', 'timeout', 'sensitiveRole'].includes(moduleKey) ? targetId : null);
}

async function restoreRole(guild, snapshot) {
    const role = await guild.roles.create({
        name: snapshot.name,
        color: snapshot.color,
        hoist: snapshot.hoist,
        mentionable: snapshot.mentionable,
        permissions: snapshot.permissions,
        reason: 'AntiRaid : restauration du rôle supprimé',
    });
    if (snapshot.position) await role.setPosition(snapshot.position);
}

async function restoreChannel(guild, snapshot) {
    const channel = await guild.channels.create({
        name: snapshot.name,
        type: snapshot.type,
        parent: snapshot.parentId || undefined,
        topic: snapshot.topic || undefined,
        nsfw: snapshot.nsfw,
        rateLimitPerUser: snapshot.rateLimitPerUser || undefined,
        permissionOverwrites: snapshot.permissionOverwrites,
        reason: 'AntiRaid : restauration du salon supprimé',
    });
    if (snapshot.position) await channel.setPosition(snapshot.position);
}

function captureRole(role) {
    return {
        name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable,
        permissions: role.permissions.bitfield.toString(), position: role.position,
    };
}

function captureChannel(channel) {
    return {
        name: channel.name, type: channel.type, parentId: channel.parentId,
        topic: channel.topic, nsfw: channel.nsfw, rateLimitPerUser: channel.rateLimitPerUser,
        position: channel.position,
        permissionOverwrites: channel.permissionOverwrites?.cache.map((overwrite) => ({
            id: overwrite.id, type: overwrite.type, allow: overwrite.allow.bitfield.toString(),
            deny: overwrite.deny.bitfield.toString(),
        })) || [],
    };
}

function isCategoryPingExempt(content, mentionedRoleIds, rule) {
    const hasHere = /@here\b/i.test(content);
    const hasEveryone = /@everyone\b/i.test(content);
    const hasGiveawayRole = mentionedRoleIds.some((roleId) => rule.roleIds?.includes(roleId));
    return !hasEveryone && (hasHere || hasGiveawayRole);
}

async function handleConfiguredMentionAccess(message, config) {
    const categoryId = message.channel.parentId || message.channel.parent?.parentId;
    const categoryRule = categoryId ? config.accessCategories?.[categoryId] : null;
    if (categoryRule && isCategoryPingExempt(message.content, message.mentions.roles.map((role) => role.id), categoryRule)) return true;

    const rule = config.accessRules[message.channel.id];
    if (!rule || !message.mentions.everyone) return false;

    const hasHere = /@here\b/i.test(message.content);
    const hasEveryone = /@everyone\b/i.test(message.content);
    const allowedTypes = rule.mention === 'both' ? ['here', 'everyone'] : [rule.mention];
    const requestedTypes = [
        ...(hasHere ? ['here'] : []),
        ...(hasEveryone ? ['everyone'] : []),
    ];
    const member = message.member;
    const hasAllowedRole = member?.roles.cache.has(rule.allowedRoleId);
    const hasSpecialRole = member?.roles.cache.has(rule.specialRoleId);
    const unauthorizedTypes = requestedTypes.filter((type) => !allowedTypes.includes(type));
    const cooldowns = config.accessCooldowns[message.channel.id] || {};
    const lastUse = cooldowns[message.author.id] || 0;
    const cooldownEndsAt = lastUse + 60 * 60 * 1000;
    const rateLimited = !hasSpecialRole && cooldownEndsAt > Date.now();

    if (unauthorizedTypes.length || (!hasAllowedRole && !hasSpecialRole) || rateLimited) {
        if (!message.deletable) {
            throw new Error(`Impossible de supprimer la mention non autorisée dans le salon ${message.channel.id}; le bot doit avoir Gérer les messages.`);
        }
        await message.delete();
        const reason = !hasAllowedRole && !hasSpecialRole
            ? 'le membre n’a pas le rôle autorisé'
            : unauthorizedTypes.length
                ? `type(s) non autorisé(s) : ${unauthorizedTypes.join(', ')}`
                : `limite horaire atteinte (réessaie <t:${Math.ceil(cooldownEndsAt / 1000)}:R>)`;
        await sendLog(
            message.guild,
            config,
            'Mention bloquée par /acces',
            `<@${message.author.id}> — <#${message.channel.id}>\nRaison : ${reason}.`,
            'everyone',
        );
        return true;
    }

    if (!hasSpecialRole) {
        const now = Date.now();
        for (const [channelId, users] of Object.entries(config.accessCooldowns)) {
            for (const [userId, usedAt] of Object.entries(users)) {
                if (now - usedAt >= 24 * 60 * 60 * 1000) delete users[userId];
            }
            if (Object.keys(users).length === 0) delete config.accessCooldowns[channelId];
        }
        config.accessCooldowns[message.channel.id] = {
            ...(config.accessCooldowns[message.channel.id] || {}),
            [message.author.id]: now,
        };
        saveConfig(message.guild.id, config);
    }
    return true;
}

async function handleMessage(message) {
    if (!message.guild || message.author.bot) return;
    const config = getConfig(message.guild.id);
    const accessMentionHandled = await handleConfiguredMentionAccess(message, config);
    if (!config.enabled || isBypassed(config, message.author.id, 'spam')) return;
    const modules = [];
    if (message.mentions.everyone && !accessMentionHandled) modules.push('everyone');
    if (/https?:\/\/\S+/i.test(message.content)) modules.push('links');
    const key = `${message.guild.id}:${message.author.id}:message`;
    const recent = (trackers.get(key) || []).filter((time) => Date.now() - time < 5_000);
    recent.push(Date.now());
    trackers.set(key, recent);
    if (recent.length >= (config.limits.spam || 3)) modules.push('spam');

    for (const moduleKey of new Set(modules)) {
        if (!config.modules[moduleKey]) continue;
        if (isBypassed(config, message.author.id, moduleKey)) continue;
        if (isShielded(config, message.author.id)) continue;
        if (moduleKey === 'links' || moduleKey === 'everyone' || moduleKey === 'spam') {
            if (message.deletable) await message.delete();
        }
        await punish(message.guild, config, moduleKey, message.author.id,
            `Détection dans <#${message.channel.id}>.`, message.member);
    }
}

async function handleVoiceUpdate(oldState, newState) {
    const guild = newState.guild;
    const config = getConfig(guild.id);
    if (!config.enabled) return;
    let moduleKey = null;
    if (oldState.channelId !== newState.channelId) {
        moduleKey = oldState.channelId && !newState.channelId ? 'voiceDisconnect' : 'voiceMove';
    } else if (oldState.serverMute !== newState.serverMute) {
        moduleKey = 'voiceMute';
    } else if (oldState.serverDeaf !== newState.serverDeaf) {
        moduleKey = 'voiceDeafen';
    }
    if (!moduleKey || !config.modules[moduleKey]) return;
    const targetId = newState.id;
    const action = ['voiceMute', 'voiceDeafen'].includes(moduleKey)
        ? AuditLogEvent.MemberUpdate
        : moduleKey === 'voiceDisconnect' ? AuditLogEvent.MemberDisconnect : AuditLogEvent.MemberMove;
    try {
        const voiceChangeKey = moduleKey === 'voiceMute' ? 'mute' : 'deaf';
        const entry = await auditEntryFor(guild, action, targetId, (auditEntry) =>
            !['voiceMute', 'voiceDeafen'].includes(moduleKey) ||
            auditEntry.changes?.some((change) => change.key === voiceChangeKey));
        if (!entry) return;
        const restore = async () => {
            if (newState.member?.voice.channelId !== oldState.channelId) {
                await newState.member.voice.setChannel(oldState.channelId, 'AntiRaid : restauration du déplacement vocal');
            }
            if (newState.serverMute !== oldState.serverMute || newState.serverDeaf !== oldState.serverDeaf) {
                await newState.member.voice.setMute(oldState.serverMute, 'AntiRaid : restauration du mute');
                await newState.member.voice.setDeaf(oldState.serverDeaf, 'AntiRaid : restauration de la sourdine');
            }
        };
        await punish(guild, config, moduleKey, entry.executorId,
            `Action vocale sur <@${targetId}>.`, newState.member, restore);
    } catch (error) {
        console.error(`[AntiRaid] Erreur de surveillance vocale (${guild.id}):`, error);
    }
}

function panelPayload(config) {
    const selected = MODULES.find(([key]) => config.modules[key])?.[0] || MODULES[0][0];
    const selector = new StringSelectMenuBuilder()
        .setCustomId('protect_module')
        .setPlaceholder('Choisir un module à configurer')
        .addOptions(MODULES.map(([value, label]) => ({
            label, value, description: `${config.modules[value] ? 'Activé' : 'Désactivé'} · limite ${config.limits[value] || 3}`,
            default: value === selected,
        })));
    const status = MODULES.map(([key, label]) => `${config.modules[key] ? '🟢' : '⚫'} ${label}`).join('\n');
    const actionSelect = new StringSelectMenuBuilder().setCustomId('protect_action')
        .setPlaceholder('Sanction à appliquer au dépassement de limite')
        .addOptions(SANCTIONS.map((value) => ({ label: SANCTION_LABELS[value], value, default: config.sanction === value })));
    const container = new ContainerBuilder()
        .setAccentColor(PANEL_COLOR)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## 🛡️ Protection AntiRaid\nProtection globale : **${config.enabled ? 'activée' : 'désactivée'}**\nSanction : **${SANCTION_LABELS[config.sanction]}**`,
            ),
            new TextDisplayBuilder().setContent(status),
            new TextDisplayBuilder().setContent('-# Choisis un module pour activer ou désactiver sa surveillance. Configure la limite avec `/limit`.'),
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(selector),
            new ActionRowBuilder().addComponents(actionSelect),
        );
    return { components: [container], flags: COMPONENTS_V2_FLAGS };
}

function accessPanelPayload(config, selectedCategoryId = null) {
    const categories = Object.entries(config.accessCategories || {});
    const selectedRule = selectedCategoryId ? config.accessCategories[selectedCategoryId] : null;
    const categorySelect = new ChannelSelectMenuBuilder()
        .setCustomId('protect_access_category')
        .setPlaceholder('Choisir une catégorie')
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(1);
    const container = new ContainerBuilder()
        .setAccentColor(PANEL_COLOR)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                '## Configuration des pings spéciaux\nChoisis une catégorie : **@here** et le rôle giveaway sélectionné dans cette catégorie seront sans limite. Le rôle se règle dans le deuxième menu.',
            ),
            new TextDisplayBuilder().setContent(
                categories.length
                    ? `**Catégories configurées**\n${categories.map(([id, rule]) =>
                        `<#${id}> — rôles sans limite : ${rule.roleIds?.length ? rule.roleIds.map((roleId) => `<@&${roleId}>`).join(', ') : 'aucun (seul @here est exempté)'}`).join('\n')}`
                    : 'Aucune catégorie configurée pour le moment.',
            ),
        )
        .addActionRowComponents(new ActionRowBuilder().addComponents(categorySelect));

    if (selectedCategoryId && selectedRule) {
        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId('protect_access_roles')
            .setPlaceholder('Choisir les rôles giveaway sans limite')
            .setMinValues(1)
            .setMaxValues(10);
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `Catégorie sélectionnée : <#${selectedCategoryId}>\nRôles giveaway configurés : ${selectedRule.roleIds?.length ? selectedRule.roleIds.map((roleId) => `<@&${roleId}>`).join(', ') : 'aucun'}`,
            ),
        ).addActionRowComponents(
            new ActionRowBuilder().addComponents(roleSelect),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('protect_access_clear_roles')
                    .setLabel('Retirer les rôles giveaway')
                    .setStyle(ButtonStyle.Secondary),
            ),
        );
    }

    return { components: [container], flags: EPHEMERAL_V2_FLAGS };
}

async function handleCommand(interaction) {
    const { commandName } = interaction;
    const guild = interaction.guild;
    if (!guild) return replyV2(interaction, 'Serveur requis', 'Cette commande doit être utilisée dans un serveur.');
    const config = getConfig(guild.id);
    const requireManager = () => {
        if (isGuildManager(interaction)) return true;
        replyV2(interaction, 'Accès refusé', 'Cette commande est réservée au propriétaire du serveur, aux owners AntiRaid et aux administrateurs.');
        return false;
    };

    if (commandName === 'panel') {
        if (!requireManager()) return;
        return interaction.reply({ ...panelPayload(config), flags: EPHEMERAL_V2_FLAGS });
    }
    if (commandName === 'limit') {
        if (!requireManager()) return;
        const moduleKey = interaction.options.getString('module', true);
        const limit = interaction.options.getInteger('nombre', true);
        config.limits[moduleKey] = limit;
        saveConfig(guild.id, config);
        return replyV2(interaction, 'Limite mise à jour', `**${MODULE_NAMES.get(moduleKey)}** : ${limit} action(s) autorisée(s) sur ${config.windowSeconds} secondes.`);
    }
    if (commandName === 'on' || commandName === 'off') {
        if (!requireManager()) return;
        config.enabled = commandName === 'on';
        if (config.enabled) for (const key of Object.keys(config.modules)) config.modules[key] = true;
        else for (const key of Object.keys(config.modules)) config.modules[key] = false;
        saveConfig(guild.id, config);
        return replyV2(interaction, 'Protection mise à jour', `La protection AntiRaid est **${commandName === 'on' ? 'activée' : 'désactivée'}**.`);
    }
    if (commandName === 'info') {
        return replyV2(interaction, 'Niveaux de bypass AntiRaid',
            '• Owner du serveur et owners AntiRaid : bypass complet.\n• Membres whitelistés : bypass des modules sélectionnés.\n• Shield : protège la cible des actions surveillées.\n• Les administrateurs ne sont pas automatiquement exemptés ; ajoute-les à la whitelist si nécessaire.');
    }
    if (commandName === 'multi') {
        if (!requireManager()) return;
        const moduleKey = interaction.options.getString('module', true);
        const destinationGuildId = interaction.options.getString('serveur_id', true).trim();
        if (!/^\d{17,20}$/.test(destinationGuildId)) {
            return replyV2(interaction, 'ID invalide', 'L’ID du serveur doit être un identifiant Discord valide (17 à 20 chiffres).');
        }
        const destinationGuild = await client.guilds.fetch(destinationGuildId).catch((error) => {
            if ([10004, 50001].includes(error.code)) return null;
            throw error;
        });
        if (!destinationGuild) {
            return replyV2(interaction, 'Serveur introuvable', 'Ajoute d’abord le bot au serveur de logs, puis réessaie.');
        }
        let channel;
        let channelCreated;
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            if (moduleKey === 'all') {
                const usedChannelIds = new Set();
                const results = [];
                for (const [key] of MODULES) {
                    const result = await getOrCreateLogChannel(destinationGuild, config, key, usedChannelIds);
                    config.logs[key] = result.channel.id;
                    usedChannelIds.add(result.channel.id);
                    saveConfig(guild.id, config);
                    results.push({ key, ...result });
                }
                delete config.logs.general;
                saveConfig(guild.id, config);
                for (const { key, channel: logChannel } of results) {
                    await logChannel.send(v2Payload(
                        '🛡️ Protect AntiRaid — logs configurés',
                        `Les journaux du module **${MODULE_NAMES.get(key)}** du serveur **${guild.name}** seront envoyés ici.`,
                        false,
                    ));
                }
                const summary = results.map(({ key, channel: logChannel }) => `• ${MODULE_NAMES.get(key)} : #${logChannel.name}`).join('\n');
                return interaction.editReply(v2Payload(
                    'Salons de logs configurés',
                    `Les ${results.length} salons ont été créés ou réutilisés sur **${destinationGuild.name}** :\n${summary}`,
                    false,
                ));
            }
            const result = await getOrCreateLogChannel(destinationGuild, config, moduleKey);
            channel = result.channel;
            channelCreated = result.created;
        } catch (error) {
            if (error.code === 50013 || error.code === 50001) {
                const content = 'Le bot n’a pas les permissions nécessaires sur le serveur de logs. Donne-lui **Gérer les salons** pour créer le salon privé.';
                return interaction.deferred
                    ? interaction.editReply(v2Payload('Permissions manquantes', content, false))
                    : replyV2(interaction, 'Permissions manquantes', content);
            }
            throw error;
        }
        config.logs[moduleKey] = channel.id;
        saveConfig(guild.id, config);
        await channel.send(v2Payload(
            '🛡️ Protect AntiRaid — logs configurés',
            `Les journaux du module **${MODULE_NAMES.get(moduleKey)}** du serveur **${guild.name}** seront envoyés ici.`,
            false,
        ));
        return interaction.deferred ? interaction.editReply({
            ...v2Payload('Salon de logs configuré',
                `Salon privé #${channel.name} ${channelCreated ? 'créé automatiquement' : 'existant réutilisé'} sur **${destinationGuild.name}**. Les logs de **${MODULE_NAMES.get(moduleKey)}** y seront envoyés.`, false),
        }) : interaction.reply({
            ...v2Payload('Salon de logs configuré',
                `Salon privé ${channel} ${channelCreated ? 'créé automatiquement' : 'existant réutilisé'} sur **${destinationGuild.name}**. Les logs de **${MODULE_NAMES.get(moduleKey)}** y seront envoyés.`),
        });
    }
    if (commandName === 'acces') {
        if (!requireManager()) return;
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'configurer') {
            return interaction.reply(accessPanelPayload(config));
        }
        if (subcommand === 'liste') {
            const rules = Object.entries(config.accessCategories || {});
            const description = rules.length
                ? rules.map(([categoryId, rule]) => {
                    const category = guild.channels.cache.get(categoryId);
                    const categoryLabel = category ? `<#${categoryId}>` : `catégorie supprimée (${categoryId})`;
                    return `${categoryLabel} — @here sans limite\nRôles giveaway sans limite : ${rule.roleIds?.length ? rule.roleIds.map((roleId) => `<@&${roleId}>`).join(', ') : 'aucun'}`;
                }).join('\n\n')
                : 'Aucune règle de mention configurée.';
            return replyV2(interaction, 'Catégories avec pings sans limite', description);
        }

        const category = interaction.options.getChannel('categorie', true);
        if (subcommand === 'retirer') {
            delete config.accessCategories[category.id];
            saveConfig(guild.id, config);
            return replyV2(interaction, 'Règle retirée', `Les exceptions de ping sans limite ont été retirées de ${category}.`);
        }
    }
    if (commandName === 'owner') {
        if (!canManageOwners(interaction)) return replyV2(interaction, 'Accès refusé', 'Seul le propriétaire du serveur ou un owner bot peut gérer les owners.');
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
            const user = interaction.options.getUser('membre', true);
            if (!config.owners.includes(user.id)) config.owners.push(user.id);
            saveConfig(guild.id, config);
            return replyV2(interaction, 'Owner ajouté', `${user} a été ajouté aux owners AntiRaid.`);
        }
        if (sub === 'remove') {
            const id = interaction.options.getString('id', true);
            config.owners = config.owners.filter((ownerId) => ownerId !== id);
            saveConfig(guild.id, config);
            return replyV2(interaction, 'Owner retiré', `L’owner \`${id}\` a été retiré.`);
        }
        return replyV2(interaction, 'Owners AntiRaid',
            config.owners.length ? config.owners.map((id) => `<@${id}> — ${id}`).join('\n') : 'Aucun owner configuré.');
    }
    if (commandName === 'shield' || commandName === 'wl') {
        if (!requireManager()) return;
        const sub = interaction.options.getSubcommand();
        if (sub === 'list') {
            const lines = commandName === 'shield'
                ? (config.shield.length ? config.shield.map((id) => `<@${id}> — ${id}`) : ['Aucun membre Shield.'])
                : Object.entries(config.whitelist).flatMap(([id, modules]) => modules.map((moduleKey) => `<@${id}> — ${moduleKey === 'all' ? 'Tous les modules' : MODULE_NAMES.get(moduleKey)}`));
            return replyV2(interaction, commandName === 'shield' ? 'Membres Shield' : 'Whitelist AntiRaid', lines.join('\n'));
        }
        const user = interaction.options.getUser('membre', true);
        if (commandName === 'shield') {
            if (sub === 'add' && !config.shield.includes(user.id)) config.shield.push(user.id);
            if (sub === 'remove') config.shield = config.shield.filter((id) => id !== user.id);
        } else {
            const moduleKey = interaction.options.getString('module', true);
            if (moduleKey === 'all') {
                if (sub === 'add') config.whitelist[user.id] = ['all'];
                else delete config.whitelist[user.id];
            } else {
                const entries = new Set(config.whitelist[user.id] || []);
                if (sub === 'add') entries.add(moduleKey);
                else entries.delete(moduleKey);
                if (entries.size) config.whitelist[user.id] = [...entries];
                else delete config.whitelist[user.id];
            }
        }
        saveConfig(guild.id, config);
        return replyV2(interaction, commandName === 'shield' ? 'Shield mis à jour' : 'Whitelist mise à jour',
            `${user} — configuration ${sub === 'add' ? 'mise à jour' : 'retirée'}.`);
    }
    if (commandName === 'reset') {
        if (!buyers.has(interaction.user.id)) return replyV2(interaction, 'Accès refusé', 'Commande réservée au buyer. Configure PROTECT_BUYER_IDS dans le fichier .env.');
        saveConfig(guild.id, structuredClone(DEFAULTS));
        return replyV2(interaction, 'Configuration réinitialisée', 'La configuration AntiRaid a été réinitialisée.');
    }
    if (commandName === 'profil') {
        if (!isBotOwner(interaction.user.id)) return replyV2(interaction, 'Accès refusé', 'Commande réservée aux owners bot définis dans PROTECT_OWNER_IDS.');
        const name = interaction.options.getString('nom');
        const avatar = interaction.options.getString('avatar');
        const status = interaction.options.getString('statut');
        if (!name && !avatar && !status) return replyV2(interaction, 'Profil incomplet', 'Indique au moins un nom, une URL d’avatar ou un statut.');
        if (avatar && !/^https:\/\/\S+$/i.test(avatar)) return replyV2(interaction, 'URL invalide', 'L’avatar doit être une URL HTTPS.');
        if (name) await client.user.setUsername(name);
        if (avatar) await client.user.setAvatar(avatar);
        if (status) client.user.setActivity(status);
        return replyV2(interaction, 'Profil mis à jour', 'Le profil du bot a été mis à jour.');
    }
}

client.once('ready', async () => {
    console.log(`[AntiRaid] Connecté : ${client.user.tag}`);
    for (const guild of client.guilds.cache.values()) {
        const config = getConfig(guild.id);
        for (const [userId, expiresAt] of Object.entries(config.tempBans)) scheduleUnban(guild, userId, expiresAt);
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) return await handleCommand(interaction);
        if (interaction.isChannelSelectMenu() && interaction.customId === 'protect_access_category') {
            if (!isGuildManager(interaction)) return replyV2(interaction, 'Accès refusé', 'Tu ne peux pas modifier ces règles.');
            const categoryId = interaction.values[0];
            const category = interaction.guild.channels.cache.get(categoryId);
            if (!category || category.type !== ChannelType.GuildCategory) {
                return replyV2(interaction, 'Catégorie invalide', 'Sélectionne une catégorie de ce serveur.');
            }
            const config = getConfig(interaction.guildId);
            config.accessCategories[categoryId] ||= { roleIds: [] };
            pendingAccessCategories.set(`${interaction.guildId}:${interaction.user.id}`, {
                categoryId,
                expiresAt: Date.now() + 15 * 60 * 1000,
            });
            saveConfig(interaction.guildId, config);
            return interaction.update(accessPanelPayload(config, categoryId));
        }
        if (interaction.isRoleSelectMenu() && interaction.customId === 'protect_access_roles') {
            if (!isGuildManager(interaction)) return replyV2(interaction, 'Accès refusé', 'Tu ne peux pas modifier ces règles.');
            const pendingKey = `${interaction.guildId}:${interaction.user.id}`;
            const pending = pendingAccessCategories.get(pendingKey);
            if (!pending || pending.expiresAt < Date.now()) {
                pendingAccessCategories.delete(pendingKey);
                return replyV2(interaction, 'Sélection expirée', 'Relance `/acces configurer` et choisis une catégorie.');
            }
            const config = getConfig(interaction.guildId);
            const selectedRoles = interaction.values.filter((roleId) => roleId !== interaction.guildId);
            config.accessCategories[pending.categoryId] = { roleIds: selectedRoles };
            saveConfig(interaction.guildId, config);
            return interaction.update(accessPanelPayload(config, pending.categoryId));
        }
        if (interaction.isButton() && interaction.customId === 'protect_access_clear_roles') {
            if (!isGuildManager(interaction)) return replyV2(interaction, 'Accès refusé', 'Tu ne peux pas modifier ces règles.');
            const pendingKey = `${interaction.guildId}:${interaction.user.id}`;
            const pending = pendingAccessCategories.get(pendingKey);
            if (!pending || pending.expiresAt < Date.now()) {
                pendingAccessCategories.delete(pendingKey);
                return replyV2(interaction, 'Sélection expirée', 'Relance `/acces configurer` et choisis une catégorie.');
            }
            const config = getConfig(interaction.guildId);
            config.accessCategories[pending.categoryId] = { roleIds: [] };
            saveConfig(interaction.guildId, config);
            return interaction.update(accessPanelPayload(config, pending.categoryId));
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'protect_module') {
            if (!isGuildManager(interaction)) return replyV2(interaction, 'Accès refusé', 'Tu ne peux pas modifier ce panneau.');
            const config = getConfig(interaction.guildId);
            const moduleKey = interaction.values[0];
            const limit = interaction.options?.getInteger?.('limite');
            config.modules[moduleKey] = !config.modules[moduleKey];
            if (limit) config.limits[moduleKey] = limit;
            saveConfig(interaction.guildId, config);
            return interaction.update(panelPayload(config));
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'protect_action') {
            if (!isGuildManager(interaction)) return replyV2(interaction, 'Accès refusé', 'Tu ne peux pas modifier ce panneau.');
            const config = getConfig(interaction.guildId);
            config.sanction = interaction.values[0];
            saveConfig(interaction.guildId, config);
            return interaction.update(panelPayload(config));
        }
    } catch (error) {
        console.error('[AntiRaid] Erreur interaction :', error);
        const response = v2Payload('Erreur', 'Une erreur est survenue. Vérifie les permissions du bot et les logs.');
        if (interaction.deferred || interaction.replied) await interaction.followUp(response);
        else await interaction.reply(response);
    }
});

client.on('guildAuditLogEntryCreate', async (entry, guild) => {
    const key = `${guild.id}:${entry.id}`;
    if (pendingAuditEvents.has(key)) return;
    pendingAuditEvents.add(key);
    try {
        await handleAuditEntry(entry, guild);
    } catch (error) {
        console.error(`[AntiRaid] Erreur audit log (${entry.action}, ${guild.id}):`, error);
    } finally {
        pendingAuditEvents.delete(key);
    }
});

client.on('roleDelete', (role) => {
    deletedSnapshots.set(`role:${role.id}`, captureRole(role));
    setTimeout(() => deletedSnapshots.delete(`role:${role.id}`), 20_000).unref?.();
});
client.on('channelDelete', (channel) => {
    deletedSnapshots.set(`channel:${channel.id}`, captureChannel(channel));
    setTimeout(() => deletedSnapshots.delete(`channel:${channel.id}`), 20_000).unref?.();
});
client.on('messageCreate', (message) => handleMessage(message).catch((error) => console.error('[AntiRaid] Erreur message :', error)));
client.on('voiceStateUpdate', (oldState, newState) => handleVoiceUpdate(oldState, newState));

if (require.main === module) {
    if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN manquant dans protect/.env');
    if (process.argv.includes('--deploy')) {
        if (!process.env.CLIENT_ID) throw new Error('CLIENT_ID manquant dans protect/.env');
        const rest = new REST().setToken(process.env.DISCORD_TOKEN);
        const route = process.env.GUILD_ID
            ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
            : Routes.applicationCommands(process.env.CLIENT_ID);
        rest.put(route, { body: commands })
            .then(() => {
                const scope = process.env.GUILD_ID ? `le serveur ${process.env.GUILD_ID}` : 'globalement';
                console.log(`[AntiRaid] ${commands.length} commandes déployées pour ${scope}.`);
                if (!process.env.GUILD_ID) {
                    console.log('[AntiRaid] Les commandes globales peuvent prendre jusqu’à une heure à apparaître.');
                }
            })
            .catch((error) => {
                console.error('[AntiRaid] Échec du déploiement des commandes :', error);
                process.exitCode = 1;
            });
    } else {
        client.login(process.env.DISCORD_TOKEN).catch((error) => {
            console.error('[AntiRaid] Échec de connexion :', error);
            process.exitCode = 1;
        });
    }
}

module.exports = { client, commands, getConfig, saveConfig, MODULES, isCategoryPingExempt };

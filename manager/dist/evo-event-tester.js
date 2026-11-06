// Live Event Tester — extends the manager UI with a slide-out drawer that
// can both (a) trigger any Evolution API endpoint with a copy-as-curl
// affordance, and (b) simulate any of the 32 webhook events by POSTing a
// synthetic payload from the browser to a developer-controlled URL.
//
// Pure vanilla DOM — runs after the React bundle has booted and never
// touches React state. The sidebar entry is re-injected via MutationObserver
// (the same pattern as evo-enhancements.js) because React re-mounts the nav
// on route changes.

(function () {
  'use strict';

  // ── Context detection ────────────────────────────────────────────────
  const INSTANCE_RE = /\/manager\/instance\/([^/?#]+)/;
  const LS_KEY = (instance) => `evo:event-tester:${instance || '_global'}`;
  const LS_APIKEY = 'evo_apikey_cache';

  let cachedApiKey = null;
  try {
    cachedApiKey = localStorage.getItem(LS_APIKEY) || null;
  } catch (_) {
    /* localStorage may be disabled */
  }

  /** @type {Map<string, string>} instance-name -> per-instance token */
  const tokenCache = new Map();
  let tokenFetchPromise = null;

  function getInstanceFromPath() {
    const m = location.pathname.match(INSTANCE_RE);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function rememberApiKey(value) {
    if (!value || typeof value !== 'string') return;
    if (cachedApiKey === value) return;
    cachedApiKey = value;
    try {
      localStorage.setItem(LS_APIKEY, value);
    } catch (_) {}
  }

  // Sniff the bundle's outgoing apikey header from fetch + XHR. The manager
  // sets this header on every authenticated call, so we'll have it after the
  // first request the React app makes.
  (function installApiKeySniff() {
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          const h =
            init && init.headers
              ? init.headers
              : input && input.headers
                ? input.headers
                : null;
          if (h) {
            if (typeof Headers !== 'undefined' && h instanceof Headers) {
              const v = h.get('apikey') || h.get('Apikey') || h.get('APIKEY');
              if (v) rememberApiKey(v);
            } else if (Array.isArray(h)) {
              for (const [k, v] of h) {
                if (k && k.toLowerCase() === 'apikey') rememberApiKey(v);
              }
            } else if (typeof h === 'object') {
              for (const k of Object.keys(h)) {
                if (k && k.toLowerCase() === 'apikey') rememberApiKey(h[k]);
              }
            }
          }
        } catch (_) {}
        return origFetch(input, init);
      };
    }

    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR && OrigXHR.prototype && OrigXHR.prototype.setRequestHeader) {
      const origSet = OrigXHR.prototype.setRequestHeader;
      OrigXHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (name && String(name).toLowerCase() === 'apikey') {
            rememberApiKey(String(value));
          }
        } catch (_) {}
        return origSet.call(this, name, value);
      };
    }
  })();

  function getApiKey() {
    return cachedApiKey || '';
  }

  function getServerUrl() {
    return location.origin;
  }

  async function fetchInstanceToken(instance) {
    if (!instance) return '';
    if (tokenCache.has(instance)) return tokenCache.get(instance) || '';
    if (!cachedApiKey) return '';
    if (!tokenFetchPromise) {
      tokenFetchPromise = fetch('/instance/fetchInstances', {
        headers: { apikey: cachedApiKey, Accept: 'application/json' },
      })
        .then((r) => (r.ok ? r.json() : []))
        .then((list) => {
          if (Array.isArray(list)) {
            for (const inst of list) {
              if (inst && inst.name) tokenCache.set(inst.name, inst.token || '');
              if (inst && inst.instanceName)
                tokenCache.set(inst.instanceName, inst.token || '');
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          tokenFetchPromise = null;
        });
    }
    await tokenFetchPromise;
    return tokenCache.get(instance) || '';
  }

  // Best-effort apikey for the copied curl: per-instance token wins because
  // it's the minimum-privilege secret the user already trusts to a single
  // instance. Falls back to the global apikey the bundle is using.
  async function getCurlApiKey(instance) {
    const t = await fetchInstanceToken(instance);
    return t || getApiKey();
  }

  // ── Persistence ──────────────────────────────────────────────────────
  function loadState(instance) {
    try {
      const raw = localStorage.getItem(LS_KEY(instance));
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (_) {
      return {};
    }
  }

  function saveState(instance, patch) {
    try {
      const next = { ...loadState(instance), ...patch };
      localStorage.setItem(LS_KEY(instance), JSON.stringify(next));
    } catch (_) {}
  }

  // ── Endpoint catalog ─────────────────────────────────────────────────
  // Field shape:
  //   { key, label, type, placeholder?, required?, options?, json?, common?, file? }
  // `common: 'sender' | 'body'` lets the top-of-form bound inputs fan out
  // to whichever endpoint is currently selected.
  // `json: true` renders a JSON textarea pre-filled with the placeholder
  // (parsed and merged into the body at submit time).
  // `file: true` flags multipart endpoints (the `file` field carries the
  // upload).

  const F = {
    number: {
      key: 'number',
      label: 'Recipient number',
      type: 'text',
      placeholder: '5511999999999',
      required: true,
      common: 'sender',
    },
    delay: { key: 'delay', label: 'Delay (ms)', type: 'number', placeholder: '0' },
    linkPreview: { key: 'linkPreview', label: 'Link preview', type: 'boolean' },
    mentionsEveryOne: {
      key: 'mentionsEveryOne',
      label: 'Mention everyone',
      type: 'boolean',
    },
    messageId: {
      key: 'messageId',
      label: 'Custom message ID',
      type: 'text',
      placeholder: 'auto',
    },
  };

  const ENDPOINTS = [
    // ───── Messages — JSON ─────────────────────────────────────────────
    {
      id: 'message.sendText',
      group: 'Messages',
      label: 'Send Text',
      method: 'POST',
      path: '/message/sendText/:instance',
      fields: [
        F.number,
        {
          key: 'text',
          label: 'Message body',
          type: 'textarea',
          placeholder: 'Hello from Evolution!',
          required: true,
          common: 'body',
        },
        F.delay,
        F.linkPreview,
        F.mentionsEveryOne,
      ],
    },
    {
      id: 'message.sendLocation',
      group: 'Messages',
      label: 'Send Location',
      method: 'POST',
      path: '/message/sendLocation/:instance',
      fields: [
        F.number,
        {
          key: 'latitude',
          label: 'Latitude',
          type: 'number',
          placeholder: '-23.55052',
          required: true,
        },
        {
          key: 'longitude',
          label: 'Longitude',
          type: 'number',
          placeholder: '-46.633308',
          required: true,
        },
        { key: 'name', label: 'Place name', type: 'text', placeholder: 'São Paulo' },
        {
          key: 'address',
          label: 'Address',
          type: 'text',
          placeholder: 'Brazil',
          common: 'body',
        },
      ],
    },
    {
      id: 'message.sendContact',
      group: 'Messages',
      label: 'Send Contact',
      method: 'POST',
      path: '/message/sendContact/:instance',
      fields: [
        F.number,
        {
          key: 'contact',
          label: 'Contact list (JSON array)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: JSON.stringify(
            [
              {
                fullName: 'Jane Doe',
                wuid: '5511988887777',
                phoneNumber: '+55 11 98888-7777',
                organization: 'Acme',
                email: 'jane@example.com',
              },
            ],
            null,
            2,
          ),
        },
      ],
    },
    {
      id: 'message.sendReaction',
      group: 'Messages',
      label: 'Send Reaction',
      method: 'POST',
      path: '/message/sendReaction/:instance',
      fields: [
        {
          key: 'key',
          label: 'Message key (JSON)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: JSON.stringify(
            {
              remoteJid: '5511999999999@s.whatsapp.net',
              fromMe: false,
              id: 'BAE5XXXXXXXXX',
            },
            null,
            2,
          ),
        },
        {
          key: 'reaction',
          label: 'Reaction emoji',
          type: 'text',
          required: true,
          placeholder: '🔥',
          common: 'body',
        },
      ],
    },
    {
      id: 'message.sendPoll',
      group: 'Messages',
      label: 'Send Poll',
      method: 'POST',
      path: '/message/sendPoll/:instance',
      fields: [
        F.number,
        {
          key: 'name',
          label: 'Question',
          type: 'text',
          required: true,
          common: 'body',
        },
        {
          key: 'selectableCount',
          label: 'Selectable count',
          type: 'number',
          placeholder: '1',
          required: true,
        },
        {
          key: 'values',
          label: 'Options (JSON string array)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: JSON.stringify(['Yes', 'No', 'Maybe'], null, 2),
        },
      ],
    },
    {
      id: 'message.sendList',
      group: 'Messages',
      label: 'Send List',
      method: 'POST',
      path: '/message/sendList/:instance',
      fields: [
        F.number,
        { key: 'title', label: 'Title', type: 'text', required: true, common: 'body' },
        { key: 'description', label: 'Description', type: 'text' },
        { key: 'buttonText', label: 'Button text', type: 'text', required: true },
        { key: 'footerText', label: 'Footer', type: 'text' },
        {
          key: 'sections',
          label: 'Sections (JSON)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: JSON.stringify(
            [
              {
                title: 'Section 1',
                rows: [
                  { title: 'Option A', description: 'First', rowId: 'a' },
                  { title: 'Option B', description: 'Second', rowId: 'b' },
                ],
              },
            ],
            null,
            2,
          ),
        },
      ],
    },
    {
      id: 'message.sendButtons',
      group: 'Messages',
      label: 'Send Buttons',
      method: 'POST',
      path: '/message/sendButtons/:instance',
      fields: [
        F.number,
        { key: 'title', label: 'Title', type: 'text', required: true },
        {
          key: 'description',
          label: 'Description',
          type: 'text',
          common: 'body',
        },
        { key: 'footer', label: 'Footer', type: 'text' },
        {
          key: 'buttons',
          label: 'Buttons (JSON array)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: JSON.stringify(
            [
              { type: 'reply', displayText: 'Yes', id: 'yes' },
              { type: 'reply', displayText: 'No', id: 'no' },
            ],
            null,
            2,
          ),
        },
      ],
    },
    {
      id: 'message.sendCarousel',
      group: 'Messages',
      label: 'Send Carousel',
      method: 'POST',
      path: '/message/sendCarousel/:instance',
      fields: [
        F.number,
        {
          key: 'body',
          label: 'Body text',
          type: 'text',
          required: true,
          common: 'body',
        },
        {
          key: 'cards',
          label: 'Cards (JSON array)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: JSON.stringify(
            [
              {
                title: 'Card 1',
                body: 'First card body',
                buttons: [{ type: 'reply', displayText: 'Pick', id: '1' }],
              },
            ],
            null,
            2,
          ),
        },
      ],
    },
    {
      id: 'message.sendTemplate',
      group: 'Messages',
      label: 'Send Template (Business)',
      method: 'POST',
      path: '/message/sendTemplate/:instance',
      fields: [
        F.number,
        { key: 'name', label: 'Template name', type: 'text', required: true },
        {
          key: 'language',
          label: 'Language code',
          type: 'text',
          placeholder: 'en_US',
          required: true,
        },
        {
          key: 'components',
          label: 'Components (JSON)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: JSON.stringify(
            [{ type: 'body', parameters: [{ type: 'text', text: 'hi' }] }],
            null,
            2,
          ),
        },
      ],
    },

    // ───── Messages — multipart (file upload) ─────────────────────────
    {
      id: 'message.sendMedia',
      group: 'Messages',
      label: 'Send Media',
      method: 'POST',
      path: '/message/sendMedia/:instance',
      multipart: true,
      note: 'Accepts file upload OR `media` URL/base64 — leave file blank to send by URL.',
      fields: [
        F.number,
        {
          key: 'mediatype',
          label: 'Media type',
          type: 'select',
          required: true,
          options: ['image', 'video', 'document', 'audio'],
        },
        { key: 'mimetype', label: 'MIME type', type: 'text', placeholder: 'image/png' },
        {
          key: 'caption',
          label: 'Caption',
          type: 'textarea',
          common: 'body',
          placeholder: 'Optional caption',
        },
        { key: 'fileName', label: 'File name (for documents)', type: 'text' },
        {
          key: 'media',
          label: 'Media URL or base64 (if no file upload)',
          type: 'text',
          placeholder: 'https://example.com/image.png',
        },
        { key: 'file', label: 'File upload (optional)', type: 'file', file: true },
        F.delay,
      ],
    },
    {
      id: 'message.sendPtv',
      group: 'Messages',
      label: 'Send PTV (round video)',
      method: 'POST',
      path: '/message/sendPtv/:instance',
      multipart: true,
      fields: [
        F.number,
        { key: 'video', label: 'Video URL/base64', type: 'text' },
        { key: 'file', label: 'File upload (optional)', type: 'file', file: true },
      ],
    },
    {
      id: 'message.sendWhatsAppAudio',
      group: 'Messages',
      label: 'Send Audio (voice note)',
      method: 'POST',
      path: '/message/sendWhatsAppAudio/:instance',
      multipart: true,
      fields: [
        F.number,
        { key: 'audio', label: 'Audio URL/base64', type: 'text' },
        { key: 'file', label: 'File upload (optional)', type: 'file', file: true },
        F.delay,
      ],
    },
    {
      id: 'message.sendSticker',
      group: 'Messages',
      label: 'Send Sticker',
      method: 'POST',
      path: '/message/sendSticker/:instance',
      multipart: true,
      fields: [
        F.number,
        { key: 'sticker', label: 'Sticker URL/base64', type: 'text' },
        { key: 'file', label: 'File upload (optional)', type: 'file', file: true },
      ],
    },
    {
      id: 'message.sendStatus',
      group: 'Messages',
      label: 'Send Status',
      method: 'POST',
      path: '/message/sendStatus/:instance',
      multipart: true,
      fields: [
        {
          key: 'type',
          label: 'Type',
          type: 'select',
          required: true,
          options: ['text', 'image', 'video', 'audio'],
        },
        { key: 'content', label: 'Content (text or URL)', type: 'text', common: 'body' },
        { key: 'caption', label: 'Caption', type: 'text' },
        { key: 'backgroundColor', label: 'Background color', type: 'text' },
        { key: 'font', label: 'Font (1-5)', type: 'number' },
        { key: 'allContacts', label: 'Send to all contacts', type: 'boolean' },
        {
          key: 'statusJidList',
          label: 'Recipient JIDs (JSON array)',
          type: 'textarea',
          json: true,
          placeholder: '["5511999999999@s.whatsapp.net"]',
        },
        { key: 'file', label: 'File upload (optional)', type: 'file', file: true },
      ],
    },

    // ───── Chat ───────────────────────────────────────────────────────
    {
      id: 'chat.whatsappNumbers',
      group: 'Chat',
      label: 'Check WhatsApp numbers',
      method: 'POST',
      path: '/chat/whatsappNumbers/:instance',
      fields: [
        {
          key: 'numbers',
          label: 'Numbers (JSON array)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: '["5511999999999","5511988887777"]',
        },
      ],
    },
    {
      id: 'chat.markMessageAsRead',
      group: 'Chat',
      label: 'Mark messages as read',
      method: 'POST',
      path: '/chat/markMessageAsRead/:instance',
      fields: [
        {
          key: 'readMessages',
          label: 'Messages (JSON array of keys)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: JSON.stringify(
            [
              {
                remoteJid: '5511999999999@s.whatsapp.net',
                fromMe: false,
                id: 'BAE5XXXX',
              },
            ],
            null,
            2,
          ),
        },
      ],
    },
    {
      id: 'chat.markMessageAsPlayed',
      group: 'Chat',
      label: 'Mark messages as played',
      method: 'POST',
      path: '/chat/markMessageAsPlayed/:instance',
      fields: [
        {
          key: 'playedMessages',
          label: 'Messages (JSON array of keys)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: '[]',
        },
      ],
    },
    {
      id: 'chat.archiveChat',
      group: 'Chat',
      label: 'Archive chat',
      method: 'POST',
      path: '/chat/archiveChat/:instance',
      fields: [
        {
          key: 'chat',
          label: 'Chat JID',
          type: 'text',
          placeholder: '5511999999999@s.whatsapp.net',
          common: 'sender',
        },
        { key: 'archive', label: 'Archive', type: 'boolean', required: true },
        {
          key: 'lastMessage',
          label: 'Last message (JSON, optional)',
          type: 'textarea',
          json: true,
          placeholder: '{}',
        },
      ],
    },
    {
      id: 'chat.markChatUnread',
      group: 'Chat',
      label: 'Mark chat as unread',
      method: 'POST',
      path: '/chat/markChatUnread/:instance',
      fields: [
        {
          key: 'chat',
          label: 'Chat JID',
          type: 'text',
          common: 'sender',
          required: true,
        },
        {
          key: 'lastMessage',
          label: 'Last message (JSON, optional)',
          type: 'textarea',
          json: true,
          placeholder: '{}',
        },
      ],
    },
    {
      id: 'chat.deleteMessageForEveryone',
      group: 'Chat',
      label: 'Delete message for everyone',
      method: 'DELETE',
      path: '/chat/deleteMessageForEveryone/:instance',
      fields: [
        {
          key: 'remoteJid',
          label: 'Remote JID',
          type: 'text',
          required: true,
          common: 'sender',
        },
        { key: 'id', label: 'Message ID', type: 'text', required: true },
        { key: 'fromMe', label: 'Was sent by me', type: 'boolean' },
        { key: 'participant', label: 'Participant (groups)', type: 'text' },
      ],
    },
    {
      id: 'chat.fetchProfilePictureUrl',
      group: 'Chat',
      label: 'Fetch profile picture URL',
      method: 'POST',
      path: '/chat/fetchProfilePictureUrl/:instance',
      fields: [
        {
          key: 'number',
          label: 'Number',
          type: 'text',
          required: true,
          common: 'sender',
        },
      ],
    },
    {
      id: 'chat.fetchProfile',
      group: 'Chat',
      label: 'Fetch profile',
      method: 'POST',
      path: '/chat/fetchProfile/:instance',
      fields: [{ key: 'number', label: 'Number', type: 'text', common: 'sender' }],
    },
    {
      id: 'chat.fetchBusinessProfile',
      group: 'Chat',
      label: 'Fetch business profile',
      method: 'POST',
      path: '/chat/fetchBusinessProfile/:instance',
      fields: [
        { key: 'number', label: 'Number', type: 'text', required: true, common: 'sender' },
      ],
    },
    {
      id: 'chat.fetchLid',
      group: 'Chat',
      label: 'Fetch LID',
      method: 'POST',
      path: '/chat/fetchLid/:instance',
      fields: [
        { key: 'number', label: 'Number', type: 'text', required: true, common: 'sender' },
      ],
    },
    {
      id: 'chat.updateMessage',
      group: 'Chat',
      label: 'Edit message',
      method: 'POST',
      path: '/chat/updateMessage/:instance',
      fields: [
        { key: 'number', label: 'Number', type: 'text', required: true, common: 'sender' },
        {
          key: 'text',
          label: 'New text',
          type: 'textarea',
          required: true,
          common: 'body',
        },
        {
          key: 'key',
          label: 'Message key (JSON)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: JSON.stringify(
            {
              remoteJid: '5511999999999@s.whatsapp.net',
              fromMe: true,
              id: 'BAE5XXXX',
            },
            null,
            2,
          ),
        },
      ],
    },
    {
      id: 'chat.sendPresence',
      group: 'Chat',
      label: 'Send presence',
      method: 'POST',
      path: '/chat/sendPresence/:instance',
      fields: [
        { key: 'number', label: 'Number', type: 'text', required: true, common: 'sender' },
        {
          key: 'presence',
          label: 'Presence',
          type: 'select',
          required: true,
          options: [
            'unavailable',
            'available',
            'composing',
            'recording',
            'paused',
          ],
        },
        { key: 'delay', label: 'Delay (ms)', type: 'number', placeholder: '1200' },
      ],
    },
    {
      id: 'chat.updateBlockStatus',
      group: 'Chat',
      label: 'Block / unblock user',
      method: 'POST',
      path: '/chat/updateBlockStatus/:instance',
      fields: [
        { key: 'number', label: 'Number', type: 'text', required: true, common: 'sender' },
        {
          key: 'status',
          label: 'Action',
          type: 'select',
          required: true,
          options: ['block', 'unblock'],
        },
      ],
    },
    {
      id: 'chat.findContacts',
      group: 'Chat',
      label: 'Find contacts',
      method: 'POST',
      path: '/chat/findContacts/:instance',
      fields: [
        {
          key: 'where',
          label: 'Where clause (JSON)',
          type: 'textarea',
          json: true,
          placeholder: '{"id":"5511999999999@s.whatsapp.net"}',
        },
      ],
    },
    {
      id: 'chat.findMessages',
      group: 'Chat',
      label: 'Find messages',
      method: 'POST',
      path: '/chat/findMessages/:instance',
      fields: [
        {
          key: 'where',
          label: 'Where (JSON)',
          type: 'textarea',
          json: true,
          placeholder: '{"key":{"remoteJid":"5511999999999@s.whatsapp.net"}}',
        },
        { key: 'limit', label: 'Limit', type: 'number', placeholder: '50' },
      ],
    },
    {
      id: 'chat.findStatusMessage',
      group: 'Chat',
      label: 'Find status messages',
      method: 'POST',
      path: '/chat/findStatusMessage/:instance',
      fields: [
        {
          key: 'where',
          label: 'Where (JSON)',
          type: 'textarea',
          json: true,
          placeholder: '{}',
        },
      ],
    },
    {
      id: 'chat.findChats',
      group: 'Chat',
      label: 'Find chats',
      method: 'POST',
      path: '/chat/findChats/:instance',
      fields: [
        {
          key: 'where',
          label: 'Where (JSON)',
          type: 'textarea',
          json: true,
          placeholder: '{}',
        },
      ],
    },
    {
      id: 'chat.findChatByRemoteJid',
      group: 'Chat',
      label: 'Find chat by remote JID',
      method: 'GET',
      path: '/chat/findChatByRemoteJid/:instance',
      query: ['remoteJid'],
      fields: [
        {
          key: 'remoteJid',
          label: 'Remote JID',
          type: 'text',
          required: true,
          query: true,
          common: 'sender',
        },
      ],
    },
    {
      id: 'chat.findChannels',
      group: 'Chat',
      label: 'Find channels',
      method: 'POST',
      path: '/chat/findChannels/:instance',
      fields: [
        {
          key: 'where',
          label: 'Where (JSON)',
          type: 'textarea',
          json: true,
          placeholder: '{}',
        },
      ],
    },
    {
      id: 'chat.updateProfileName',
      group: 'Chat',
      label: 'Update profile name',
      method: 'POST',
      path: '/chat/updateProfileName/:instance',
      fields: [{ key: 'name', label: 'New name', type: 'text', required: true, common: 'body' }],
    },
    {
      id: 'chat.updateProfileStatus',
      group: 'Chat',
      label: 'Update profile status',
      method: 'POST',
      path: '/chat/updateProfileStatus/:instance',
      fields: [{ key: 'status', label: 'Status', type: 'text', required: true, common: 'body' }],
    },
    {
      id: 'chat.updateProfilePicture',
      group: 'Chat',
      label: 'Update profile picture',
      method: 'POST',
      path: '/chat/updateProfilePicture/:instance',
      fields: [{ key: 'picture', label: 'Picture URL/base64', type: 'text', required: true }],
    },
    {
      id: 'chat.removeProfilePicture',
      group: 'Chat',
      label: 'Remove profile picture',
      method: 'DELETE',
      path: '/chat/removeProfilePicture/:instance',
      fields: [],
    },
    {
      id: 'chat.fetchPrivacySettings',
      group: 'Chat',
      label: 'Fetch privacy settings',
      method: 'GET',
      path: '/chat/fetchPrivacySettings/:instance',
      fields: [],
    },
    {
      id: 'chat.updatePrivacySettings',
      group: 'Chat',
      label: 'Update privacy settings',
      method: 'POST',
      path: '/chat/updatePrivacySettings/:instance',
      fields: [
        { key: 'readreceipts', label: 'Read receipts', type: 'select', options: ['all', 'none'] },
        { key: 'profile', label: 'Profile', type: 'select', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
        { key: 'status', label: 'Status', type: 'select', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
        { key: 'online', label: 'Online', type: 'select', options: ['all', 'match_last_seen'] },
        { key: 'last', label: 'Last seen', type: 'select', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
        { key: 'groupadd', label: 'Group add', type: 'select', options: ['all', 'contacts', 'contact_blacklist'] },
      ],
    },
    {
      id: 'chat.getPollVote',
      group: 'Chat',
      label: 'Decrypt poll vote',
      method: 'POST',
      path: '/chat/getPollVote/:instance',
      fields: [
        {
          key: 'message',
          label: 'Message (JSON)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: '{"key":{"id":"BAE5XXXX"}}',
        },
        { key: 'remoteJid', label: 'Remote JID', type: 'text', required: true, common: 'sender' },
      ],
    },
    {
      id: 'chat.getBase64FromMediaMessage',
      group: 'Chat',
      label: 'Get base64 from media message',
      method: 'POST',
      path: '/chat/getBase64FromMediaMessage/:instance',
      fields: [
        {
          key: 'message',
          label: 'Web message info (JSON)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: '{}',
        },
        { key: 'convertToMp4', label: 'Convert to MP4', type: 'boolean' },
      ],
    },

    // ───── Group ──────────────────────────────────────────────────────
    {
      id: 'group.create',
      group: 'Group',
      label: 'Create group',
      method: 'POST',
      path: '/group/create/:instance',
      fields: [
        { key: 'subject', label: 'Subject', type: 'text', required: true, common: 'body' },
        {
          key: 'participants',
          label: 'Participants (JSON array)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: '["5511999999999"]',
        },
        { key: 'description', label: 'Description', type: 'text' },
        { key: 'promoteParticipants', label: 'Promote all', type: 'boolean' },
      ],
    },
    {
      id: 'group.updateGroupSubject',
      group: 'Group',
      label: 'Update group subject',
      method: 'POST',
      path: '/group/updateGroupSubject/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
        { key: 'subject', label: 'Subject', type: 'text', required: true, common: 'body' },
      ],
    },
    {
      id: 'group.updateGroupPicture',
      group: 'Group',
      label: 'Update group picture',
      method: 'POST',
      path: '/group/updateGroupPicture/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
        { key: 'image', label: 'Image URL/base64', type: 'text', required: true },
      ],
    },
    {
      id: 'group.updateGroupDescription',
      group: 'Group',
      label: 'Update group description',
      method: 'POST',
      path: '/group/updateGroupDescription/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
        { key: 'description', label: 'Description', type: 'text', required: true, common: 'body' },
      ],
    },
    {
      id: 'group.findGroupInfos',
      group: 'Group',
      label: 'Find group info',
      method: 'GET',
      path: '/group/findGroupInfos/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
      ],
    },
    {
      id: 'group.fetchAllGroups',
      group: 'Group',
      label: 'Fetch all groups',
      method: 'GET',
      path: '/group/fetchAllGroups/:instance',
      query: ['getParticipants'],
      fields: [
        {
          key: 'getParticipants',
          label: 'Include participants',
          type: 'select',
          required: true,
          query: true,
          options: ['true', 'false'],
        },
      ],
    },
    {
      id: 'group.participants',
      group: 'Group',
      label: 'Group participants',
      method: 'GET',
      path: '/group/participants/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
      ],
    },
    {
      id: 'group.inviteCode',
      group: 'Group',
      label: 'Group invite code',
      method: 'GET',
      path: '/group/inviteCode/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
      ],
    },
    {
      id: 'group.inviteInfo',
      group: 'Group',
      label: 'Invite info',
      method: 'GET',
      path: '/group/inviteInfo/:instance',
      query: ['inviteCode'],
      fields: [
        { key: 'inviteCode', label: 'Invite code', type: 'text', required: true, query: true, common: 'body' },
      ],
    },
    {
      id: 'group.acceptInviteCode',
      group: 'Group',
      label: 'Accept invite',
      method: 'GET',
      path: '/group/acceptInviteCode/:instance',
      query: ['inviteCode'],
      fields: [
        { key: 'inviteCode', label: 'Invite code', type: 'text', required: true, query: true, common: 'body' },
      ],
    },
    {
      id: 'group.sendInvite',
      group: 'Group',
      label: 'Send group invite',
      method: 'POST',
      path: '/group/sendInvite/:instance',
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, common: 'sender' },
        { key: 'description', label: 'Description', type: 'text', required: true, common: 'body' },
        {
          key: 'numbers',
          label: 'Recipients (JSON array)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: '["5511999999999"]',
        },
      ],
    },
    {
      id: 'group.revokeInviteCode',
      group: 'Group',
      label: 'Revoke invite code',
      method: 'POST',
      path: '/group/revokeInviteCode/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
      ],
    },
    {
      id: 'group.updateParticipant',
      group: 'Group',
      label: 'Update participant',
      method: 'POST',
      path: '/group/updateParticipant/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
        {
          key: 'action',
          label: 'Action',
          type: 'select',
          required: true,
          options: ['add', 'remove', 'promote', 'demote'],
        },
        {
          key: 'participants',
          label: 'Participants (JSON array)',
          type: 'textarea',
          json: true,
          required: true,
          placeholder: '["5511999999999"]',
        },
      ],
    },
    {
      id: 'group.updateSetting',
      group: 'Group',
      label: 'Update group setting',
      method: 'POST',
      path: '/group/updateSetting/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
        {
          key: 'action',
          label: 'Setting',
          type: 'select',
          required: true,
          options: ['announcement', 'not_announcement', 'locked', 'unlocked'],
        },
      ],
    },
    {
      id: 'group.updateMemberAddMode',
      group: 'Group',
      label: 'Update member add mode',
      method: 'POST',
      path: '/group/updateMemberAddMode/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
        {
          key: 'mode',
          label: 'Mode',
          type: 'select',
          required: true,
          options: ['admin_add', 'all_member_add'],
        },
      ],
    },
    {
      id: 'group.toggleEphemeral',
      group: 'Group',
      label: 'Toggle ephemeral',
      method: 'POST',
      path: '/group/toggleEphemeral/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
        {
          key: 'expiration',
          label: 'Expiration (seconds)',
          type: 'select',
          required: true,
          options: ['0', '86400', '604800', '7776000'],
        },
      ],
    },
    {
      id: 'group.leaveGroup',
      group: 'Group',
      label: 'Leave group',
      method: 'DELETE',
      path: '/group/leaveGroup/:instance',
      query: ['groupJid'],
      fields: [
        { key: 'groupJid', label: 'Group JID', type: 'text', required: true, query: true, common: 'sender' },
      ],
    },

    // ───── Instance ──────────────────────────────────────────────────
    {
      id: 'instance.create',
      group: 'Instance',
      label: 'Create instance',
      method: 'POST',
      path: '/instance/create',
      fields: [
        { key: 'instanceName', label: 'Instance name', type: 'text', required: true, common: 'body' },
        { key: 'qrcode', label: 'Generate QR', type: 'boolean' },
        { key: 'integration', label: 'Integration', type: 'select', options: ['WHATSAPP-BAILEYS', 'WHATSAPP-BUSINESS', 'EVOLUTION'] },
        { key: 'token', label: 'Per-instance token', type: 'text' },
        { key: 'number', label: 'Phone number', type: 'text' },
        { key: 'webhook', label: 'Webhook config (JSON)', type: 'textarea', json: true, placeholder: '{"url":"https://example.com/webhook","enabled":true}' },
      ],
    },
    {
      id: 'instance.fetchInstances',
      group: 'Instance',
      label: 'Fetch all instances',
      method: 'GET',
      path: '/instance/fetchInstances',
      fields: [],
    },
    {
      id: 'instance.connect',
      group: 'Instance',
      label: 'Connect (QR)',
      method: 'GET',
      path: '/instance/connect/:instance',
      fields: [],
    },
    {
      id: 'instance.connectionState',
      group: 'Instance',
      label: 'Connection state',
      method: 'GET',
      path: '/instance/connectionState/:instance',
      fields: [],
    },
    {
      id: 'instance.restart',
      group: 'Instance',
      label: 'Restart',
      method: 'POST',
      path: '/instance/restart/:instance',
      fields: [],
    },
    {
      id: 'instance.setPresence',
      group: 'Instance',
      label: 'Set presence',
      method: 'POST',
      path: '/instance/setPresence/:instance',
      fields: [
        {
          key: 'presence',
          label: 'Presence',
          type: 'select',
          required: true,
          options: ['available', 'unavailable'],
        },
      ],
    },
    {
      id: 'instance.logout',
      group: 'Instance',
      label: 'Logout',
      method: 'DELETE',
      path: '/instance/logout/:instance',
      fields: [],
    },
    {
      id: 'instance.delete',
      group: 'Instance',
      label: 'Delete instance',
      method: 'DELETE',
      path: '/instance/delete/:instance',
      fields: [],
    },
  ];

  // ── Event catalog ────────────────────────────────────────────────────
  // Payload shape mirrors webhook.controller.ts:93-103. Templates can use
  // ctx.sender, ctx.body, ctx.instance, ctx.serverUrl, ctx.apikey, and
  // ctx.webhookUrl. If a template doesn't reference sender/body, those
  // inputs are hidden automatically.

  const newId = () =>
    'BAE5' + Math.random().toString(16).slice(2, 14).toUpperCase().padEnd(12, '0');
  const now = () => Math.floor(Date.now() / 1000);

  function wrap(eventName, dataFn, hint) {
    return (ctx) => ({
      event: eventName,
      instance: ctx.instance || '',
      data: dataFn(ctx),
      destination: ctx.webhookUrl || '',
      date_time: new Date().toISOString(),
      sender: ctx.sender || '',
      server_url: ctx.serverUrl,
      apikey: ctx.apikey || '',
      ...(hint ? { _hint: hint } : {}),
    });
  }

  const EVENTS = [
    // Connection lifecycle
    {
      id: 'application.startup',
      group: 'Lifecycle',
      uses: [],
      template: wrap('application.startup', () => ({ message: 'Application started.' })),
    },
    {
      id: 'instance.create',
      group: 'Lifecycle',
      uses: [],
      template: wrap('instance.create', (ctx) => ({
        instanceName: ctx.instance,
        instanceId: 'xxxx-xxxx-xxxx',
        status: 'created',
      })),
    },
    {
      id: 'instance.delete',
      group: 'Lifecycle',
      uses: [],
      template: wrap('instance.delete', (ctx) => ({
        instanceName: ctx.instance,
        instanceId: 'xxxx-xxxx-xxxx',
      })),
    },
    {
      id: 'qrcode.updated',
      group: 'Lifecycle',
      uses: [],
      template: wrap('qrcode.updated', () => ({
        qrcode: {
          count: 1,
          base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...',
          code: '2@AAAA...',
          pairingCode: null,
        },
      })),
    },
    {
      id: 'connection.update',
      group: 'Lifecycle',
      uses: [],
      template: wrap('connection.update', (ctx) => ({
        instance: ctx.instance,
        state: 'open',
        statusReason: 200,
      })),
    },
    {
      id: 'status.instance',
      group: 'Lifecycle',
      uses: [],
      template: wrap('status.instance', (ctx) => ({
        instance: ctx.instance,
        status: 'open',
      })),
    },
    {
      id: 'remove.instance',
      group: 'Lifecycle',
      uses: [],
      template: wrap('remove.instance', (ctx) => ({ instance: ctx.instance })),
    },
    {
      id: 'logout.instance',
      group: 'Lifecycle',
      uses: [],
      template: wrap('logout.instance', (ctx) => ({ instance: ctx.instance })),
    },
    {
      id: 'creds.update',
      group: 'Lifecycle',
      uses: [],
      template: wrap('creds.update', () => ({ updated: true })),
    },

    // Messages
    {
      id: 'messages.upsert',
      group: 'Messages',
      uses: ['sender', 'body'],
      template: wrap('messages.upsert', (ctx) => ({
        key: {
          remoteJid: `${ctx.sender}@s.whatsapp.net`,
          fromMe: false,
          id: newId(),
        },
        pushName: 'Test User',
        message: { conversation: ctx.body },
        messageType: 'conversation',
        messageTimestamp: now(),
        instanceId: 'xxxx-xxxx-xxxx',
        source: 'web',
      })),
    },
    {
      id: 'messages.set',
      group: 'Messages',
      uses: ['sender', 'body'],
      template: wrap('messages.set', (ctx) => ({
        messages: [
          {
            key: {
              remoteJid: `${ctx.sender}@s.whatsapp.net`,
              fromMe: false,
              id: newId(),
            },
            message: { conversation: ctx.body },
            messageTimestamp: now(),
          },
        ],
      })),
    },
    {
      id: 'messages.update',
      group: 'Messages',
      uses: ['sender'],
      template: wrap('messages.update', (ctx) => ({
        keyId: newId(),
        remoteJid: `${ctx.sender}@s.whatsapp.net`,
        fromMe: false,
        participant: null,
        status: 'DELIVERY_ACK',
      })),
    },
    {
      id: 'messages.edited',
      group: 'Messages',
      uses: ['sender', 'body'],
      template: wrap('messages.edited', (ctx) => ({
        key: {
          remoteJid: `${ctx.sender}@s.whatsapp.net`,
          fromMe: false,
          id: newId(),
        },
        message: { editedMessage: { message: { conversation: ctx.body } } },
        messageTimestamp: now(),
      })),
    },
    {
      id: 'messages.delete',
      group: 'Messages',
      uses: ['sender'],
      template: wrap('messages.delete', (ctx) => ({
        keyId: newId(),
        remoteJid: `${ctx.sender}@s.whatsapp.net`,
        fromMe: false,
      })),
    },
    {
      id: 'send.message',
      group: 'Messages',
      uses: ['sender', 'body'],
      template: wrap('send.message', (ctx) => ({
        key: {
          remoteJid: `${ctx.sender}@s.whatsapp.net`,
          fromMe: true,
          id: newId(),
        },
        message: { conversation: ctx.body },
        messageType: 'conversation',
        messageTimestamp: now(),
      })),
    },
    {
      id: 'send.message.update',
      group: 'Messages',
      uses: ['sender'],
      template: wrap('send.message.update', (ctx) => ({
        keyId: newId(),
        remoteJid: `${ctx.sender}@s.whatsapp.net`,
        fromMe: true,
        status: 'SERVER_ACK',
      })),
    },

    // Contacts
    {
      id: 'contacts.set',
      group: 'Contacts',
      uses: ['sender'],
      template: wrap('contacts.set', (ctx) => ({
        contacts: [
          {
            id: `${ctx.sender}@s.whatsapp.net`,
            name: 'Test User',
            notify: 'Test User',
          },
        ],
      })),
    },
    {
      id: 'contacts.upsert',
      group: 'Contacts',
      uses: ['sender'],
      template: wrap('contacts.upsert', (ctx) => ({
        contacts: [
          {
            id: `${ctx.sender}@s.whatsapp.net`,
            pushName: 'Test User',
            profilePictureUrl: null,
          },
        ],
      })),
    },
    {
      id: 'contacts.update',
      group: 'Contacts',
      uses: ['sender'],
      template: wrap('contacts.update', (ctx) => ({
        contacts: [
          {
            id: `${ctx.sender}@s.whatsapp.net`,
            pushName: 'Updated Name',
          },
        ],
      })),
    },
    {
      id: 'presence.update',
      group: 'Contacts',
      uses: ['sender'],
      template: wrap('presence.update', (ctx) => ({
        id: `${ctx.sender}@s.whatsapp.net`,
        presences: {
          [`${ctx.sender}@s.whatsapp.net`]: { lastKnownPresence: 'composing' },
        },
      })),
    },

    // Chats
    {
      id: 'chats.set',
      group: 'Chats',
      uses: ['sender'],
      template: wrap('chats.set', (ctx) => ({
        chats: [
          {
            id: `${ctx.sender}@s.whatsapp.net`,
            unreadCount: 0,
            conversationTimestamp: now(),
          },
        ],
      })),
    },
    {
      id: 'chats.upsert',
      group: 'Chats',
      uses: ['sender'],
      template: wrap('chats.upsert', (ctx) => ({
        chats: [
          {
            id: `${ctx.sender}@s.whatsapp.net`,
            unreadCount: 1,
          },
        ],
      })),
    },
    {
      id: 'chats.update',
      group: 'Chats',
      uses: ['sender'],
      template: wrap('chats.update', (ctx) => ({
        chats: [
          {
            id: `${ctx.sender}@s.whatsapp.net`,
            unreadCount: 0,
          },
        ],
      })),
    },
    {
      id: 'chats.delete',
      group: 'Chats',
      uses: ['sender'],
      template: wrap('chats.delete', (ctx) => [
        `${ctx.sender}@s.whatsapp.net`,
      ]),
    },

    // Groups
    {
      id: 'groups.upsert',
      group: 'Groups',
      uses: ['body'],
      template: wrap('groups.upsert', (ctx) => [
        {
          id: '120362000000000000@g.us',
          subject: ctx.body || 'Test Group',
          creation: now(),
        },
      ]),
    },
    {
      id: 'groups.update',
      group: 'Groups',
      uses: ['body'],
      template: wrap('groups.update', (ctx) => [
        {
          id: '120362000000000000@g.us',
          subject: ctx.body || 'Renamed Group',
        },
      ]),
    },
    {
      id: 'group-participants.update',
      group: 'Groups',
      uses: ['sender'],
      template: wrap('group-participants.update', (ctx) => ({
        id: '120362000000000000@g.us',
        participants: [`${ctx.sender}@s.whatsapp.net`],
        action: 'add',
      })),
    },

    // Calls / labels / typebot / history
    {
      id: 'call',
      group: 'Misc',
      uses: ['sender'],
      template: wrap('call', (ctx) => [
        {
          id: newId(),
          from: `${ctx.sender}@s.whatsapp.net`,
          status: 'offer',
          isVideo: false,
          isGroup: false,
        },
      ]),
    },
    {
      id: 'typebot.start',
      group: 'Misc',
      uses: ['sender'],
      template: wrap('typebot.start', (ctx) => ({
        remoteJid: `${ctx.sender}@s.whatsapp.net`,
        sessionId: 'sess_xxxxxxxx',
        status: 'opened',
      })),
    },
    {
      id: 'typebot.change-status',
      group: 'Misc',
      uses: ['sender'],
      template: wrap('typebot.change-status', (ctx) => ({
        remoteJid: `${ctx.sender}@s.whatsapp.net`,
        sessionId: 'sess_xxxxxxxx',
        status: 'closed',
      })),
    },
    {
      id: 'labels.edit',
      group: 'Misc',
      uses: ['body'],
      template: wrap('labels.edit', (ctx) => ({
        id: '1',
        name: ctx.body || 'Important',
        color: 0,
        predefinedId: null,
      })),
    },
    {
      id: 'labels.association',
      group: 'Misc',
      uses: ['sender'],
      template: wrap('labels.association', (ctx) => ({
        association: {
          type: 'chat',
          chatId: `${ctx.sender}@s.whatsapp.net`,
          labelId: '1',
        },
        type: 'add',
      })),
    },
    {
      id: 'messaging-history.set',
      group: 'Misc',
      uses: [],
      template: wrap('messaging-history.set', () => ({
        chats: [],
        contacts: [],
        messages: [],
        isLatest: true,
      })),
    },
  ];

  // ── Curl builder ─────────────────────────────────────────────────────
  function singleQuote(str) {
    return "'" + String(str).replace(/'/g, "'\\''") + "'";
  }

  function buildCurl({ method, url, headers, body, multipart }) {
    const lines = [`curl -X ${method} ${singleQuote(url)} \\`];
    for (const [k, v] of Object.entries(headers || {})) {
      if (v == null || v === '') continue;
      lines.push(`  -H ${singleQuote(`${k}: ${v}`)} \\`);
    }
    if (multipart && Array.isArray(multipart)) {
      for (const part of multipart) {
        if (part.file) {
          lines.push(`  -F ${singleQuote(`${part.name}=@${part.file}`)} \\`);
        } else if (part.value !== undefined) {
          lines.push(`  -F ${singleQuote(`${part.name}=${part.value}`)} \\`);
        }
      }
    } else if (body !== undefined && body !== null && body !== '') {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      lines.push(`  -d ${singleQuote(payload)} \\`);
    }
    // Trim trailing backslash on last line.
    const last = lines[lines.length - 1];
    if (last && last.endsWith(' \\')) lines[lines.length - 1] = last.slice(0, -2);
    return lines.join('\n');
  }

  // ── DOM helpers ──────────────────────────────────────────────────────
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function')
          node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const ICON_TERMINAL = `<svg class="evo-et-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
  const ICON_COPY = `<svg class="evo-et-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const ICON_PLAY = `<svg class="evo-et-svg" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
  const ICON_X = `<svg class="evo-et-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>`;
  const ICON_CHEVRON = `<svg class="evo-et-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

  // ── Drawer (built lazily on first open) ──────────────────────────────
  let drawerEl = null;
  let backdropEl = null;
  let state = null;

  function initState(instance) {
    const saved = loadState(instance);
    return {
      instance,
      activeTab: saved.activeTab || 'api',
      lastEndpointId: saved.lastEndpointId || ENDPOINTS[0].id,
      lastEventId: saved.lastEventId || EVENTS[0].id,
      formValues: saved.formValues || {},
      sender: saved.sender || '',
      body: saved.body || '',
      webhookUrl: saved.webhookUrl || '',
      search: { api: '', event: '' },
    };
  }

  function persist() {
    if (!state) return;
    saveState(state.instance, {
      activeTab: state.activeTab,
      lastEndpointId: state.lastEndpointId,
      lastEventId: state.lastEventId,
      formValues: state.formValues,
      sender: state.sender,
      body: state.body,
      webhookUrl: state.webhookUrl,
    });
  }

  function openDrawer() {
    const instance = getInstanceFromPath();
    if (!state || state.instance !== instance) state = initState(instance);
    if (!drawerEl) {
      backdropEl = el('div', {
        id: '__evo_et_backdrop',
        onClick: closeDrawer,
      });
      drawerEl = el('div', { id: '__evo_et_drawer', role: 'dialog' });
      document.body.appendChild(backdropEl);
      document.body.appendChild(drawerEl);
      renderDrawer();
    }
    requestAnimationFrame(() => {
      backdropEl.setAttribute('data-evo-open', 'true');
      drawerEl.setAttribute('data-evo-open', 'true');
    });
    // mark sidebar buttons as active
    document
      .querySelectorAll('button.evo-et-sidebar-btn')
      .forEach((b) => b.setAttribute('data-evo-active', 'true'));
    // pre-fill webhook URL from instance config if empty
    if (!state.webhookUrl && instance && cachedApiKey) prefillWebhook(instance);
  }

  function closeDrawer() {
    if (!drawerEl) return;
    backdropEl.removeAttribute('data-evo-open');
    drawerEl.removeAttribute('data-evo-open');
    document
      .querySelectorAll('button.evo-et-sidebar-btn')
      .forEach((b) => b.removeAttribute('data-evo-active'));
  }

  async function prefillWebhook(instance) {
    try {
      const r = await fetch(`/webhook/find/${encodeURIComponent(instance)}`, {
        headers: { apikey: cachedApiKey, Accept: 'application/json' },
      });
      if (!r.ok) return;
      const data = await r.json();
      const url = (data && (data.url || data.webhook?.url || data.webhookUrl)) || '';
      if (url && !state.webhookUrl) {
        state.webhookUrl = url;
        persist();
        const inp = drawerEl.querySelector('[data-bind="webhookUrl"]');
        if (inp) inp.value = url;
      }
    } catch (_) {}
  }

  // ── Render functions ─────────────────────────────────────────────────
  function renderDrawer() {
    drawerEl.innerHTML = '';
    drawerEl.appendChild(renderHeader());
    drawerEl.appendChild(renderTabs());
    const body = el('div', { class: 'evo-et-body' });
    body.appendChild(renderRail());
    body.appendChild(renderPane());
    drawerEl.appendChild(body);
  }

  function renderHeader() {
    return el(
      'div',
      { class: 'evo-et-header' },
      el(
        'div',
        { class: 'evo-et-title' },
        el('span', { html: ICON_TERMINAL }),
        'Event Tester',
        el('small', null, state.instance ? `· ${state.instance}` : '· no instance'),
      ),
      el('button', {
        class: 'evo-et-close',
        title: 'Close (Esc)',
        onClick: closeDrawer,
        html: ICON_X,
      }),
    );
  }

  function renderTabs() {
    const mkTab = (id, label) =>
      el(
        'button',
        {
          class: 'evo-et-tab',
          'data-active': state.activeTab === id ? 'true' : 'false',
          onClick: () => {
            state.activeTab = id;
            persist();
            renderDrawer();
          },
        },
        label,
      );
    return el(
      'div',
      { class: 'evo-et-tabs' },
      mkTab('api', 'API Tester'),
      mkTab('event', 'Event Simulator'),
    );
  }

  function renderRail() {
    if (state.activeTab === 'api') return renderApiRail();
    return renderEventRail();
  }

  function renderApiRail() {
    const rail = el('div', { class: 'evo-et-rail' });
    const search = el('div', { class: 'evo-et-search' });
    const input = el('input', {
      type: 'text',
      placeholder: 'Search endpoints…',
      value: state.search.api,
    });
    input.addEventListener('input', () => {
      state.search.api = input.value;
      list.replaceChildren(...buildApiList());
    });
    search.appendChild(input);
    rail.appendChild(search);
    const list = el('div', { class: 'evo-et-rail-list' });
    list.replaceChildren(...buildApiList());
    rail.appendChild(list);
    return rail;
  }

  function buildApiList() {
    const q = state.search.api.toLowerCase().trim();
    const filtered = ENDPOINTS.filter(
      (e) =>
        !q ||
        e.label.toLowerCase().includes(q) ||
        e.path.toLowerCase().includes(q) ||
        e.group.toLowerCase().includes(q),
    );
    const groups = ['Messages', 'Chat', 'Group', 'Instance'];
    const out = [];
    for (const g of groups) {
      const items = filtered.filter((e) => e.group === g);
      if (!items.length) continue;
      out.push(el('div', { class: 'evo-et-group-label' }, g));
      for (const e of items) {
        out.push(
          el(
            'button',
            {
              class: 'evo-et-rail-item',
              'data-active': state.lastEndpointId === e.id ? 'true' : 'false',
              onClick: () => {
                state.lastEndpointId = e.id;
                persist();
                renderDrawer();
              },
            },
            el('span', { class: 'evo-et-method', 'data-m': e.method }, e.method),
            el('span', null, e.label),
          ),
        );
      }
    }
    if (!out.length)
      out.push(
        el(
          'div',
          { style: { padding: '1rem', color: 'var(--evo-et-muted)', fontSize: '0.8rem' } },
          'No endpoints match',
        ),
      );
    return out;
  }

  function renderEventRail() {
    const rail = el('div', { class: 'evo-et-rail' });
    const search = el('div', { class: 'evo-et-search' });
    const input = el('input', {
      type: 'text',
      placeholder: 'Search events…',
      value: state.search.event,
    });
    input.addEventListener('input', () => {
      state.search.event = input.value;
      list.replaceChildren(...buildEventList());
    });
    search.appendChild(input);
    rail.appendChild(search);
    const list = el('div', { class: 'evo-et-rail-list' });
    list.replaceChildren(...buildEventList());
    rail.appendChild(list);
    return rail;
  }

  function buildEventList() {
    const q = state.search.event.toLowerCase().trim();
    const filtered = EVENTS.filter(
      (e) => !q || e.id.toLowerCase().includes(q) || e.group.toLowerCase().includes(q),
    );
    const groups = ['Lifecycle', 'Messages', 'Contacts', 'Chats', 'Groups', 'Misc'];
    const out = [];
    for (const g of groups) {
      const items = filtered.filter((e) => e.group === g);
      if (!items.length) continue;
      out.push(el('div', { class: 'evo-et-group-label' }, g));
      for (const e of items) {
        out.push(
          el(
            'button',
            {
              class: 'evo-et-rail-item',
              'data-active': state.lastEventId === e.id ? 'true' : 'false',
              onClick: () => {
                state.lastEventId = e.id;
                persist();
                renderDrawer();
              },
            },
            el('span', { class: 'evo-et-method', 'data-m': 'POST' }, 'EVT'),
            el('span', null, e.id),
          ),
        );
      }
    }
    return out;
  }

  function renderPane() {
    if (state.activeTab === 'api') return renderApiPane();
    return renderEventPane();
  }

  // ───── API Tester pane ─────
  function renderApiPane() {
    const ep = ENDPOINTS.find((e) => e.id === state.lastEndpointId) || ENDPOINTS[0];
    const pane = el('div', { class: 'evo-et-pane' });
    const scroll = el('div', { class: 'evo-et-pane-scroll' });

    const expandedPath = ep.path.replace(':instance', state.instance || '{instance}');
    const head = el(
      'div',
      { class: 'evo-et-pane-head' },
      el('h3', null, ep.label),
      el(
        'div',
        { class: 'evo-et-path' },
        el('b', null, ep.method),
        expandedPath +
          (ep.query && ep.query.length
            ? '?' + ep.query.map((q) => `${q}=…`).join('&')
            : ''),
      ),
      ep.note ? el('div', { class: 'evo-et-note' }, ep.note) : null,
    );
    scroll.appendChild(head);

    // Top "Sender / Body" common inputs — bound to the picked endpoint's
    // matching fields. Hidden when the endpoint has neither.
    const senderField = ep.fields.find((f) => f.common === 'sender');
    const bodyField = ep.fields.find((f) => f.common === 'body');
    if (senderField || bodyField) {
      const row = el('div', { class: 'evo-et-form' });
      if (senderField) {
        row.appendChild(
          mkField(
            { ...senderField, label: 'Sender (shortcut → ' + senderField.label + ')' },
            ep,
            true,
          ),
        );
      }
      if (bodyField) {
        row.appendChild(
          mkField(
            { ...bodyField, label: 'Body (shortcut → ' + bodyField.label + ')' },
            ep,
            true,
          ),
        );
      }
      scroll.appendChild(row);
      scroll.appendChild(el('div', { class: 'evo-et-curl-head' }, 'Full fields'));
    }

    const form = el('form', { class: 'evo-et-form', onSubmit: (e) => e.preventDefault() });
    for (const f of ep.fields) {
      form.appendChild(mkField(f, ep, false));
    }
    scroll.appendChild(form);

    // Curl preview
    const curlBlock = el('div', null);
    const curlHead = el(
      'div',
      { class: 'evo-et-curl-head' },
      'curl',
      el(
        'button',
        {
          class: 'evo-et-btn',
          'data-variant': 'secondary',
          type: 'button',
          onClick: async () => copyCurlForEndpoint(ep, copyBtn),
        },
        el('span', { html: ICON_COPY }),
        el('span', { class: 'evo-et-copy-label' }, 'Copy as curl'),
      ),
    );
    const copyBtn = curlHead.querySelector('button');
    const curl = el('div', { class: 'evo-et-curl' });
    curlBlock.appendChild(curlHead);
    curlBlock.appendChild(curl);
    scroll.appendChild(curlBlock);
    refreshCurl(curl, ep);

    // Watch form changes to refresh curl preview live.
    form.addEventListener('input', () => refreshCurl(curl, ep));
    form.addEventListener('change', () => refreshCurl(curl, ep));

    // Send button + response viewer
    const responseBox = el('div', null);
    const actions = el(
      'div',
      { class: 'evo-et-actions' },
      el(
        'button',
        {
          class: 'evo-et-btn',
          'data-variant': 'primary',
          type: 'button',
          onClick: () => sendEndpoint(ep, responseBox),
        },
        el('span', { html: ICON_PLAY }),
        'Send request',
      ),
    );
    scroll.appendChild(actions);
    scroll.appendChild(responseBox);

    pane.appendChild(scroll);
    return pane;
  }

  function getFormValues(epId) {
    if (!state.formValues[epId]) state.formValues[epId] = {};
    return state.formValues[epId];
  }

  function mkField(f, ep, isCommon) {
    const values = getFormValues(ep.id);
    const id = `evo-et-${ep.id}-${f.key}`;

    let inputEl;
    if (f.type === 'textarea' || f.json) {
      inputEl = el('textarea', {
        id,
        rows: f.json ? '6' : '3',
        placeholder: f.placeholder || '',
        'data-json': f.json ? 'true' : null,
      });
      inputEl.value = values[f.key] != null ? values[f.key] : '';
    } else if (f.type === 'select') {
      inputEl = el('select', { id });
      inputEl.appendChild(el('option', { value: '' }, '—'));
      for (const opt of f.options || []) {
        inputEl.appendChild(el('option', { value: opt }, opt));
      }
      inputEl.value = values[f.key] != null ? values[f.key] : '';
    } else if (f.type === 'boolean') {
      const cb = el('input', { id, type: 'checkbox' });
      cb.checked = !!values[f.key];
      cb.addEventListener('change', () => {
        values[f.key] = cb.checked;
        if (f.common && isCommon) state[f.common] = cb.checked;
        persist();
      });
      return el(
        'label',
        { class: 'evo-et-checkbox', for: id },
        cb,
        f.label,
        f.required ? el('span', { class: 'evo-et-req' }, '*') : null,
      );
    } else if (f.type === 'file') {
      inputEl = el('input', { id, type: 'file' });
    } else {
      inputEl = el('input', {
        id,
        type: f.type === 'number' ? 'number' : 'text',
        placeholder: f.placeholder || '',
      });
      inputEl.value = values[f.key] != null ? values[f.key] : '';
    }

    // Common-field cross-binding: sender ↔ body shortcuts mirror the
    // underlying endpoint field.
    if (f.common && state[f.common] && inputEl.value === '') {
      inputEl.value = state[f.common];
      values[f.key] = state[f.common];
    }

    inputEl.addEventListener('input', () => {
      values[f.key] = f.type === 'number' ? inputEl.value : inputEl.value;
      if (f.common) state[f.common] = inputEl.value;
      persist();
      // mirror to twin field if present
      if (f.common) {
        document
          .querySelectorAll(
            `#__evo_et_drawer [data-common="${f.common}"][data-twin-of="${ep.id}.${f.key}"]`,
          )
          .forEach((other) => {
            if (other !== inputEl) other.value = inputEl.value;
          });
      }
    });
    inputEl.setAttribute('data-common', f.common || '');
    inputEl.setAttribute('data-twin-of', `${ep.id}.${f.key}`);

    return el(
      'div',
      { class: 'evo-et-field' },
      el(
        'label',
        { for: id },
        f.label,
        f.required ? el('span', { class: 'evo-et-req' }, '*') : null,
      ),
      inputEl,
    );
  }

  function collectRequest(ep) {
    const values = getFormValues(ep.id) || {};
    const queryParts = [];
    const bodyObj = {};
    const multipart = [];
    let fileField = null;

    for (const f of ep.fields) {
      let v = values[f.key];
      if (v == null || v === '') continue;
      if (f.json) {
        try {
          v = JSON.parse(v);
        } catch (_) {
          // Leave as string; server will reject and we'll show the error.
        }
      } else if (f.type === 'number') {
        const n = Number(v);
        if (!Number.isNaN(n)) v = n;
      }
      if (f.query) {
        queryParts.push(
          `${encodeURIComponent(f.key)}=${encodeURIComponent(
            typeof v === 'object' ? JSON.stringify(v) : v,
          )}`,
        );
        continue;
      }
      if (f.file) {
        fileField = { key: f.key, fileEl: document.getElementById(`evo-et-${ep.id}-${f.key}`) };
        continue;
      }
      if (ep.multipart) {
        multipart.push({
          name: f.key,
          value: typeof v === 'object' ? JSON.stringify(v) : v,
        });
      } else {
        bodyObj[f.key] = v;
      }
    }

    let path = ep.path.replace(':instance', state.instance || '');
    if (queryParts.length) path += '?' + queryParts.join('&');

    return {
      method: ep.method,
      url: getServerUrl() + path,
      bodyObj,
      multipart: ep.multipart ? multipart : null,
      fileField,
    };
  }

  async function refreshCurl(target, ep) {
    const req = collectRequest(ep);
    const apikey = await getCurlApiKey(state.instance);
    const headers = { apikey };
    let bodyStr, multipart;
    if (req.multipart) {
      multipart = [...req.multipart];
      if (req.fileField) {
        multipart.unshift({ name: req.fileField.key, file: '/path/to/file' });
      }
    } else if (req.method !== 'GET' && req.method !== 'DELETE') {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(req.bodyObj, null, 2);
    } else if (Object.keys(req.bodyObj).length) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(req.bodyObj, null, 2);
    }
    target.textContent = buildCurl({
      method: req.method,
      url: req.url,
      headers,
      body: bodyStr,
      multipart,
    });
  }

  async function copyCurlForEndpoint(ep, btn) {
    const block = btn.closest('.evo-et-curl-head').nextElementSibling;
    try {
      await navigator.clipboard.writeText(block.textContent);
      btn.setAttribute('data-copied', 'true');
      setTimeout(() => btn.removeAttribute('data-copied'), 1100);
    } catch (_) {
      const sel = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(block);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  async function sendEndpoint(ep, responseBox) {
    const req = collectRequest(ep);
    const apikey = getApiKey();
    if (!apikey) {
      renderResponse(responseBox, {
        ok: false,
        status: 0,
        body:
          'No API key available yet — open any other manager page once so the bundle has authenticated, then try again.',
      });
      return;
    }
    const headers = { apikey };
    let body;
    if (req.multipart) {
      const fd = new FormData();
      for (const p of req.multipart) fd.append(p.name, p.value);
      if (req.fileField && req.fileField.fileEl && req.fileField.fileEl.files[0]) {
        fd.append(req.fileField.key, req.fileField.fileEl.files[0]);
      }
      body = fd;
    } else if (req.method !== 'GET' && Object.keys(req.bodyObj).length) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.bodyObj);
    }
    let res, text;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers,
        body: req.method === 'GET' ? undefined : body,
      });
      text = await res.text();
    } catch (err) {
      renderResponse(responseBox, {
        ok: false,
        status: 0,
        body: 'Network error: ' + (err && err.message ? err.message : String(err)),
      });
      return;
    }
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {}
    renderResponse(responseBox, { ok: res.ok, status: res.status, body: pretty });
  }

  function renderResponse(box, { ok, status, body }) {
    box.innerHTML = '';
    const head = el(
      'div',
      { class: 'evo-et-response-head' },
      el(
        'span',
        { class: 'evo-et-status', 'data-ok': ok ? 'true' : 'false' },
        status ? `${status} ${ok ? 'OK' : 'ERROR'}` : 'ERROR',
      ),
    );
    const body_ = el('div', { class: 'evo-et-response-body' }, body || '');
    const wrap_ = el('div', { class: 'evo-et-response' }, head, body_);
    box.appendChild(wrap_);
  }

  // ───── Event Simulator pane ─────
  function renderEventPane() {
    const ev = EVENTS.find((e) => e.id === state.lastEventId) || EVENTS[0];
    const pane = el('div', { class: 'evo-et-pane' });
    const scroll = el('div', { class: 'evo-et-pane-scroll' });

    const head = el(
      'div',
      { class: 'evo-et-pane-head' },
      el('h3', null, ev.id),
      el(
        'div',
        { class: 'evo-et-path' },
        el('b', null, 'POST'),
        state.webhookUrl || '— set the webhook URL below —',
      ),
      el(
        'div',
        { class: 'evo-et-note' },
        'Browser POSTs directly. No HMAC signature; receiver sees a CORS request with X-Event-Type and X-Instance-Name set.',
      ),
    );
    scroll.appendChild(head);

    const form = el('form', { class: 'evo-et-form', onSubmit: (e) => e.preventDefault() });

    const webhookField = el(
      'div',
      { class: 'evo-et-field' },
      el('label', { for: 'evo-et-webhook' }, 'Webhook URL ', el('span', { class: 'evo-et-req' }, '*')),
      (() => {
        const input = el('input', {
          id: 'evo-et-webhook',
          type: 'url',
          placeholder: 'https://your-service.example.com/webhook',
          'data-bind': 'webhookUrl',
        });
        input.value = state.webhookUrl || '';
        input.addEventListener('input', () => {
          state.webhookUrl = input.value;
          persist();
          refreshEventPreview();
        });
        return input;
      })(),
    );
    form.appendChild(webhookField);

    const uses = ev.uses || [];
    if (uses.includes('sender')) {
      const f = el(
        'div',
        { class: 'evo-et-field' },
        el('label', { for: 'evo-et-evt-sender' }, 'Sender number'),
        (() => {
          const input = el('input', {
            id: 'evo-et-evt-sender',
            type: 'text',
            placeholder: '5511999999999',
          });
          input.value = state.sender || '';
          input.addEventListener('input', () => {
            state.sender = input.value;
            persist();
            refreshEventPreview();
          });
          return input;
        })(),
      );
      form.appendChild(f);
    }
    if (uses.includes('body')) {
      const f = el(
        'div',
        { class: 'evo-et-field' },
        el('label', { for: 'evo-et-evt-body' }, 'Body'),
        (() => {
          const input = el('textarea', {
            id: 'evo-et-evt-body',
            rows: '2',
            placeholder: 'Hello from the simulator!',
          });
          input.value = state.body || '';
          input.addEventListener('input', () => {
            state.body = input.value;
            persist();
            refreshEventPreview();
          });
          return input;
        })(),
      );
      form.appendChild(f);
    }

    scroll.appendChild(form);

    // Payload preview / edit
    scroll.appendChild(el('div', { class: 'evo-et-curl-head' }, 'Payload'));
    const payloadTA = el('textarea', {
      'data-json': 'true',
      rows: '12',
      id: 'evo-et-evt-payload',
    });
    payloadTA.value = JSON.stringify(buildEventPayload(ev), null, 2);
    payloadTA.addEventListener('input', () => {
      // Mark as "user-edited" so refreshes don't clobber.
      payloadTA.dataset.userEdited = '1';
      refreshEventCurl();
    });
    scroll.appendChild(payloadTA);

    // Curl preview
    const curlHead = el(
      'div',
      { class: 'evo-et-curl-head' },
      'curl (what Evolution would POST)',
      el(
        'button',
        {
          class: 'evo-et-btn',
          'data-variant': 'secondary',
          type: 'button',
          onClick: async (e) => copyText(e.currentTarget.parentElement.nextElementSibling.textContent, e.currentTarget),
        },
        el('span', { html: ICON_COPY }),
        el('span', { class: 'evo-et-copy-label' }, 'Copy as curl'),
      ),
    );
    const curl = el('div', { class: 'evo-et-curl' });
    scroll.appendChild(curlHead);
    scroll.appendChild(curl);

    const responseBox = el('div', null);
    const actions = el(
      'div',
      { class: 'evo-et-actions' },
      el(
        'button',
        {
          class: 'evo-et-btn',
          'data-variant': 'primary',
          type: 'button',
          onClick: () => fireEvent(ev, payloadTA, responseBox),
        },
        el('span', { html: ICON_PLAY }),
        'Fire event',
      ),
      el(
        'button',
        {
          class: 'evo-et-btn',
          'data-variant': 'secondary',
          type: 'button',
          onClick: () => {
            payloadTA.dataset.userEdited = '';
            payloadTA.value = JSON.stringify(buildEventPayload(ev), null, 2);
            refreshEventCurl();
          },
        },
        'Reset payload',
      ),
    );
    scroll.appendChild(actions);
    scroll.appendChild(responseBox);

    function refreshEventPreview() {
      if (!payloadTA.dataset.userEdited) {
        payloadTA.value = JSON.stringify(buildEventPayload(ev), null, 2);
      }
      head.querySelector('.evo-et-path').lastChild.textContent =
        state.webhookUrl || '— set the webhook URL below —';
      refreshEventCurl();
    }

    function refreshEventCurl() {
      curl.textContent = buildCurl({
        method: 'POST',
        url: state.webhookUrl || 'https://your-service.example.com/webhook',
        headers: {
          'Content-Type': 'application/json',
          'X-Instance-ID': state.instance || '',
          'X-Instance-Name': state.instance || '',
          'X-Event-Type': ev.id,
          'X-Timestamp': String(Date.now()),
          'User-Agent': 'EvolutionAPI-Webhook/2.3.7',
        },
        body: payloadTA.value,
      });
    }
    refreshEventCurl();

    pane.appendChild(scroll);
    return pane;
  }

  function buildEventPayload(ev) {
    const ctx = {
      instance: state.instance || '',
      sender: state.sender || '5511999999999',
      body: state.body || 'hello',
      serverUrl: getServerUrl(),
      apikey: getApiKey(),
      webhookUrl: state.webhookUrl || '',
    };
    return ev.template(ctx);
  }

  async function fireEvent(ev, payloadTA, responseBox) {
    if (!state.webhookUrl) {
      renderResponse(responseBox, {
        ok: false,
        status: 0,
        body: 'Set a Webhook URL first.',
      });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(payloadTA.value);
    } catch (err) {
      renderResponse(responseBox, {
        ok: false,
        status: 0,
        body: 'Payload JSON is invalid: ' + err.message,
      });
      return;
    }
    try {
      const res = await fetch(state.webhookUrl, {
        method: 'POST',
        mode: 'cors',
        headers: {
          'Content-Type': 'application/json',
          'X-Instance-ID': state.instance || '',
          'X-Instance-Name': state.instance || '',
          'X-Event-Type': ev.id,
          'X-Timestamp': String(Date.now()),
        },
        body: JSON.stringify(payload),
      });
      let text = '';
      try {
        text = await res.text();
      } catch (_) {}
      renderResponse(responseBox, {
        ok: res.ok,
        status: res.status,
        body:
          text ||
          '(empty body) — if your receiver got the request but the browser shows a CORS error, that is expected: the receiver still ran. The copied curl will run with no CORS limit.',
      });
    } catch (err) {
      renderResponse(responseBox, {
        ok: false,
        status: 0,
        body:
          'Browser blocked the request (likely CORS). The receiver may have still been hit. Use the copied curl from a terminal for a definitive test.\n\n' +
          (err && err.message ? err.message : String(err)),
      });
    }
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      btn.setAttribute('data-copied', 'true');
      setTimeout(() => btn.removeAttribute('data-copied'), 1100);
    } catch (_) {}
  }

  // ── Sidebar injection ────────────────────────────────────────────────
  function injectSidebarButton() {
    // Already injected and still attached?
    const existing = document.querySelector('button.evo-et-sidebar-btn');
    if (existing && document.body.contains(existing)) return;

    // The manager's left nav contains link/button rows. We anchor on the
    // "Events" or "Configurations" button (top-level entries always present
    // on instance pages). If neither is found yet, the MutationObserver
    // will re-try when React mounts the sidebar.
    const ANCHOR_LABELS = ['Events', 'Configurations', 'Dashboard'];
    let anchorBtn = null;
    const candidates = document.querySelectorAll(
      'nav button, [data-slot="sidebar"] button, aside button',
    );
    for (const c of candidates) {
      let txt = '';
      for (const n of c.childNodes) {
        if (n.nodeType === 1 && n.tagName === 'IMG') continue;
        if (n.nodeType === 3) txt += n.nodeValue;
        else if (n.nodeType === 1) txt += n.textContent;
      }
      txt = (txt || '').trim();
      if (ANCHOR_LABELS.includes(txt)) {
        anchorBtn = c;
        break;
      }
    }
    if (!anchorBtn) return;

    // Only inject on instance pages — feature needs an instance context.
    if (!getInstanceFromPath()) return;

    const btn = el(
      'button',
      {
        class: 'evo-et-sidebar-btn',
        type: 'button',
        'data-evo-feature': 'event-tester',
        title: 'Test API calls + simulate webhook events',
        onClick: openDrawer,
      },
      el('span', { class: 'evo-et-icon', html: ICON_TERMINAL }),
      el('span', { class: 'evo-et-label' }, 'Event Tester'),
      el('span', { class: 'evo-et-badge' }, 'DEV'),
    );

    // Insert after the anchor row. Walk up to its row wrapper first so the
    // new element matches the surrounding spacing.
    const wrapper = findRowWrapper(anchorBtn);
    wrapper.insertAdjacentElement('afterend', btn);
  }

  function findRowWrapper(el) {
    // Walk up while the parent's textContent equals this element's text +
    // whitespace — i.e. while we're still inside the row's own wrapper.
    let node = el;
    const targetText = (el.textContent || '').trim();
    for (let i = 0; i < 6 && node.parentElement; i++) {
      const p = node.parentElement;
      if (p === document.body) break;
      const pText = (p.textContent || '').trim();
      if (pText === targetText) node = p;
      else break;
    }
    return node;
  }

  // ── Bootstrap ────────────────────────────────────────────────────────
  function boot() {
    injectSidebarButton();
    const observer = new MutationObserver(() => injectSidebarButton());
    observer.observe(document.body, { childList: true, subtree: true });

    // Esc closes the drawer.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawerEl && drawerEl.getAttribute('data-evo-open') === 'true') {
        closeDrawer();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

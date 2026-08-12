jest.mock('../../src/config/env', () => ({
  config: {
    gupshup: {
      apiKey: 'test-api-key',
      source: '+911111111111',
      sendTo: '+912222222222',
      sendToSecondary: '+913333333333',
      sendToTertiary: '+914444444444',
      sendToQuaternary: '+916666666666',
      templateId: 'template-id',
      statusTemplateId: 'status-template-id',
      doctorStatusTemplateId: 'doctor-status-template-id',
      appName: 'ZiglyTestApp',
    },
  },
}));

const gupshupService = require('../../src/services/gupshup.service');

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  global.fetch = jest.fn();
});

describe('sendTemplateMessage', () => {
  it('posts to Gupshup with source/destination digits only and no "+" prefix', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'submitted', messageId: 'msg-1' }));

    await gupshupService.sendTemplateMessage({
      contentVariables: { 1: 'Jane', 2: '+919999999999', 3: 'Amoxicillin' },
      headerImageUrl: 'https://example.com/rx.png',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.gupshup.io/wa/api/v1/template/msg');
    expect(options.method).toBe('POST');
    expect(options.headers.apikey).toBe('test-api-key');

    const body = new URLSearchParams(options.body);
    expect(body.get('channel')).toBe('whatsapp');
    expect(body.get('source')).toBe('911111111111');
    expect(body.get('destination')).toBe('912222222222');
    expect(body.get('src.name')).toBe('ZiglyTestApp');
    expect(JSON.parse(body.get('template'))).toEqual({
      id: 'template-id',
      params: ['Jane', '+919999999999', 'Amoxicillin'],
    });
    expect(JSON.parse(body.get('message'))).toEqual({
      type: 'image',
      image: { link: 'https://example.com/rx.png' },
    });
  });

  it('omits the message field when no headerImageUrl is given', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'submitted', messageId: 'msg-1' }));

    await gupshupService.sendTemplateMessage({ contentVariables: { 1: 'Jane', 2: '+91999', 3: '' } });

    const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
    expect(body.get('message')).toBeNull();
  });

  it('sends to an explicit destination when provided, overriding the default sendTo', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'submitted', messageId: 'msg-1' }));

    await gupshupService.sendTemplateMessage({
      contentVariables: { 1: 'Jane', 2: '+91999', 3: '' },
      destination: '+915555555555',
    });

    const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
    expect(body.get('destination')).toBe('915555555555');
  });

  it('orders params by numeric content-variable key, not object key order', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'submitted', messageId: 'msg-1' }));

    await gupshupService.sendTemplateMessage({ contentVariables: { 3: 'third', 1: 'first', 2: 'second' } });

    const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
    expect(JSON.parse(body.get('template')).params).toEqual(['first', 'second', 'third']);
  });

  it('throws an ApiError when Gupshup returns a non-ok HTTP status', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ message: 'bad request' }, false, 400));

    await expect(
      gupshupService.sendTemplateMessage({ contentVariables: { 1: 'a', 2: 'b', 3: 'c' } }),
    ).rejects.toMatchObject({ statusCode: 502, message: 'Failed to send WhatsApp template message via Gupshup' });
  });

  it('throws an ApiError when Gupshup returns status "error" despite a 200 HTTP response', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'error', message: 'invalid template' }, true, 200));

    await expect(
      gupshupService.sendTemplateMessage({ contentVariables: { 1: 'a', 2: 'b', 3: 'c' } }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('sendMediaMessage', () => {
  it('sends a document message for .pdf files', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'submitted' }));

    await gupshupService.sendMediaMessage({
      mediaUrl: 'https://example.com/rx.pdf',
      body: 'caption',
      fileExtension: '.pdf',
    });

    const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
    expect(JSON.parse(body.get('message'))).toEqual({
      type: 'file',
      url: 'https://example.com/rx.pdf',
      filename: 'prescription.pdf',
    });
  });

  it('sends an image message for non-document files', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'submitted' }));

    await gupshupService.sendMediaMessage({
      mediaUrl: 'https://example.com/rx.png',
      body: 'caption',
      fileExtension: '.png',
    });

    const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
    expect(JSON.parse(body.get('message'))).toEqual({
      type: 'image',
      originalUrl: 'https://example.com/rx.png',
      caption: 'caption',
    });
  });

  it('throws an ApiError when the send fails', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ message: 'boom' }, false, 500));

    await expect(
      gupshupService.sendMediaMessage({ mediaUrl: 'x', body: 'y', fileExtension: '.png' }),
    ).rejects.toMatchObject({ statusCode: 502, message: 'Failed to send WhatsApp media message via Gupshup' });
  });
});

describe('sendStatusTemplateMessage', () => {
  it('defaults to config.statusTemplateId when no templateId is given', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'submitted', messageId: 'status-1' }));

    await gupshupService.sendStatusTemplateMessage({
      to: '+919999999999',
      contentVariables: { 1: 'Jane', 2: 'Amoxicillin', 3: 'Approved' },
    });

    const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
    expect(JSON.parse(body.get('template')).id).toBe('status-template-id');
    expect(body.get('destination')).toBe('919999999999');
  });

  it('uses an explicit templateId when given (doctor-status template)', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'submitted', messageId: 'status-1' }));

    await gupshupService.sendStatusTemplateMessage({
      to: '+919999999999',
      templateId: 'doctor-status-template-id',
      contentVariables: { 1: 'Jane', 2: 'Dr Smith', 3: 'Approved' },
    });

    const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
    expect(JSON.parse(body.get('template')).id).toBe('doctor-status-template-id');
  });

  it('throws an ApiError when the status update send fails', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ message: 'boom' }, false, 500));

    await expect(
      gupshupService.sendStatusTemplateMessage({ to: '+91999', contentVariables: { 1: 'a', 2: 'b', 3: 'c' } }),
    ).rejects.toMatchObject({ statusCode: 502, message: 'Failed to send WhatsApp status update to customer' });
  });
});

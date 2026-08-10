jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));

const pool = require('../../src/db/pool');
const {
  createPrescriptionRequest,
  updateStatusByMessageId,
  findByMessageId,
  findRecentByPhone,
  existsByShopifyOrderId,
} = require('../../src/repositories/prescriptionRequest.repository');

describe('createPrescriptionRequest', () => {
  it('inserts all fields and returns the new row id', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 42 }] });

    const id = await createPrescriptionRequest({
      gupshupMessageId: 'primary-id',
      secondaryGupshupMessageId: 'secondary-id',
      tertiaryGupshupMessageId: 'tertiary-id',
      quaternaryGupshupMessageId: 'quaternary-id',
      customerName: 'Jane Doe',
      customerPhone: '+919999999999',
      method: 'upload',
      fileUrl: 'https://example.com/rx.png',
      products: [{ product_id: 1 }],
      shopifyOrderId: '#1001',
      shopifyOrderGid: 'gid://shopify/Order/1001',
    });

    expect(id).toBe(42);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO prescription_requests'),
      [
        'primary-id',
        'secondary-id',
        'tertiary-id',
        'quaternary-id',
        'Jane Doe',
        '+919999999999',
        'upload',
        'https://example.com/rx.png',
        JSON.stringify([{ product_id: 1 }]),
        '#1001',
        'gid://shopify/Order/1001',
      ],
    );
  });

  it('defaults optional fields to null and products to an empty array', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }] });

    await createPrescriptionRequest({
      gupshupMessageId: 'primary-id',
      customerName: 'Jane Doe',
      customerPhone: '+919999999999',
      method: 'consult',
    });

    const params = pool.query.mock.calls[0][1];
    expect(params).toEqual(['primary-id', null, null, null, 'Jane Doe', '+919999999999', 'consult', null, '[]', null, null]);
  });
});

describe('updateStatusByMessageId', () => {
  it('returns the updated row when a pending request matches', async () => {
    const row = { id: 1, customer_phone: '+91999', customer_name: 'Jane', products: [] };
    pool.query.mockResolvedValue({ rows: [row] });

    const result = await updateStatusByMessageId('gs-1', 'approved');

    expect(result).toEqual(row);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"), ['gs-1', 'approved']);
  });

  it('returns null when no pending row matches', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await updateStatusByMessageId('gs-unknown', 'approved');

    expect(result).toBeNull();
  });
});

describe('findByMessageId', () => {
  it('returns the matching row', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1, status: 'approved' }] });

    const result = await findByMessageId('gs-1');

    expect(result).toEqual({ id: 1, status: 'approved' });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('SELECT id, status'), ['gs-1']);
  });

  it('returns null when nothing matches', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    expect(await findByMessageId('gs-unknown')).toBeNull();
  });
});

describe('findRecentByPhone', () => {
  it('passes the phone and default limit through to the query', async () => {
    pool.query.mockResolvedValue({ rows: [{ status: 'approved' }] });

    const rows = await findRecentByPhone('+919999999999');

    expect(rows).toEqual([{ status: 'approved' }]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM prescription_requests'), [
      '+919999999999',
      50,
    ]);
  });

  it('honors a custom limit', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await findRecentByPhone('+919999999999', { limit: 5 });

    expect(pool.query).toHaveBeenCalledWith(expect.anything(), ['+919999999999', 5]);
  });
});

describe('existsByShopifyOrderId', () => {
  it('returns true when a row is found', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }] });

    expect(await existsByShopifyOrderId('#1001')).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE shopify_order_id = $1'), ['#1001']);
  });

  it('returns false when no row is found', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    expect(await existsByShopifyOrderId('#9999')).toBe(false);
  });
});

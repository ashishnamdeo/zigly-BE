jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));

describe('pendingPrescriptionUpload.repository', () => {
  // The module caches "table already ensured" state at module scope, so each
  // test re-requires a fresh instance to get an isolated, predictable
  // CREATE TABLE IF NOT EXISTS call count.
  let pool;
  let createPendingUpload;
  let consumePendingUpload;

  beforeEach(() => {
    jest.resetModules();
    pool = require('../../src/db/pool');
    ({ createPendingUpload, consumePendingUpload } = require('../../src/repositories/pendingPrescriptionUpload.repository'));
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('ensures the table exists before the first insert, then skips it on later calls', async () => {
    await createPendingUpload({ key: 'key-1', fileUrl: 'https://example.com/a.png' });

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS pending_prescription_uploads');
    expect(pool.query.mock.calls[1]).toEqual([
      expect.stringContaining('INSERT INTO pending_prescription_uploads'),
      ['key-1', 'https://example.com/a.png'],
    ]);

    await createPendingUpload({ key: 'key-2', fileUrl: 'https://example.com/b.png' });
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('upserts on conflicting keys (ON CONFLICT DO UPDATE)', async () => {
    await createPendingUpload({ key: 'key-1', fileUrl: 'https://example.com/a.png' });

    const insertCall = pool.query.mock.calls.find((call) => call[0].includes('INSERT INTO'));
    expect(insertCall[0]).toContain('ON CONFLICT (key) DO UPDATE SET file_url = EXCLUDED.file_url');
  });

  it('consumePendingUpload deletes the row and returns its file_url', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // ensureTable
    pool.query.mockResolvedValueOnce({ rows: [{ file_url: 'https://example.com/a.png' }] }); // delete

    const result = await consumePendingUpload('key-1');

    expect(result).toBe('https://example.com/a.png');
    const deleteCall = pool.query.mock.calls[1];
    expect(deleteCall[0]).toContain('DELETE FROM pending_prescription_uploads WHERE key = $1');
    expect(deleteCall[1]).toEqual(['key-1']);
  });

  it('consumePendingUpload returns null for an unknown or already-consumed key', async () => {
    const result = await consumePendingUpload('unknown-key');

    expect(result).toBeNull();
  });
});

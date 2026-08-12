jest.mock('../../src/config/env', () => ({
  config: {
    gupshup: {
      sendTo: '+911111111111',
      sendToSecondary: '+912222222222',
      sendToTertiary: '+913333333333',
      sendToQuaternary: undefined,
      primaryDoctorName: 'Dr Primary',
      secondaryDoctorName: 'Dr Secondary',
      tertiaryDoctorName: 'Dr Tertiary',
      quaternaryDoctorName: undefined,
    },
    escalation: { windowSeconds: 60 },
  },
}));
jest.mock('../../src/services/gupshup.service');
jest.mock('../../src/services/escalationScheduler.service');
jest.mock('../../src/repositories/prescriptionRequest.repository');
jest.mock('../../src/utils/logger');
jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));

const gupshupService = require('../../src/services/gupshup.service');
const schedulerService = require('../../src/services/escalationScheduler.service');
const repo = require('../../src/repositories/prescriptionRequest.repository');
const flow = require('../../src/services/doctorApprovalFlow.service');

beforeEach(() => {
  jest.clearAllMocks();
  repo.insertDoctorRequestLog.mockResolvedValue('log-1');
  schedulerService.scheduleEscalationCheck.mockResolvedValue();
});

describe('startFlow', () => {
  it('creates the request as pending_primary and pages only the primary doctor', async () => {
    repo.createPrescriptionRequest.mockResolvedValue('req-1');
    gupshupService.sendTemplateMessage.mockResolvedValue({ messageId: 'gs-primary' });

    const id = await flow.startFlow({
      customerName: 'Jane Doe',
      customerPhone: '+919999999999',
      method: 'consult',
      products: [{ title: 'Amoxicillin', quantity: 2 }],
      headerImageUrl: 'https://example.com/banner.png',
    });

    expect(id).toBe('req-1');
    expect(repo.createPrescriptionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ customerName: 'Jane Doe', status: 'pending_primary' }),
    );
    expect(gupshupService.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(gupshupService.sendTemplateMessage).toHaveBeenCalledWith({
      contentVariables: { 1: 'Jane Doe', 2: '+919999999999', 3: 'Amoxicillin (x2)' },
      headerImageUrl: 'https://example.com/banner.png',
      destination: '+911111111111',
    });
    expect(repo.insertDoctorRequestLog).toHaveBeenCalledWith(
      expect.objectContaining({ prescriptionRequestId: 'req-1', doctorSlot: 'primary', gupshupMessageId: 'gs-primary' }),
    );
    expect(schedulerService.scheduleEscalationCheck).toHaveBeenCalledWith({
      requestId: 'req-1',
      slot: 'primary',
      delaySeconds: 60,
    });
  });

  it('logs a send_failed attempt and does not schedule an escalation when the WhatsApp send fails', async () => {
    repo.createPrescriptionRequest.mockResolvedValue('req-1');
    gupshupService.sendTemplateMessage.mockRejectedValue(new Error('gupshup down'));

    await flow.startFlow({ customerName: 'Jane', customerPhone: '+91999', method: 'consult', products: [] });

    expect(repo.markDoctorLogSendFailed).toHaveBeenCalledWith('log-1', expect.any(String));
    expect(schedulerService.scheduleEscalationCheck).not.toHaveBeenCalled();
  });
});

describe('resolve', () => {
  const log = {
    log_id: 'log-1',
    doctor_slot: 'primary',
    prescription_request_id: 'req-1',
    doctor_name: 'Dr Primary',
    doctor_mobile: '+911111111111',
  };

  it('returns "unknown" when the message id is not recognized', async () => {
    repo.findDoctorLogByMessageId.mockResolvedValue(null);

    expect(await flow.resolve('gs-unknown', 'approved')).toEqual({ outcome: 'unknown' });
    expect(repo.transitionRequestStatus).not.toHaveBeenCalled();
  });

  it('resolves the request when the CAS transition wins', async () => {
    repo.findDoctorLogByMessageId.mockResolvedValue(log);
    const won = { id: 'req-1', status: 'approved' };
    repo.transitionRequestStatus.mockResolvedValue(won);

    const result = await flow.resolve('gs-1', 'approved');

    expect(repo.transitionRequestStatus).toHaveBeenCalledWith('req-1', 'pending_primary', 'approved', {
      doctorName: 'Dr Primary',
      doctorMobile: '+911111111111',
    });
    expect(repo.markDoctorLogResponded).toHaveBeenCalledWith('log-1', 'approved');
    expect(result).toEqual({ outcome: 'resolved', request: won, slot: 'primary' });
  });

  it('marks the reply "late" and returns the current request state when the CAS transition loses', async () => {
    repo.findDoctorLogByMessageId.mockResolvedValue(log);
    repo.transitionRequestStatus.mockResolvedValue(null);
    repo.markDoctorLogSuperseded.mockResolvedValue(true);
    const current = { id: 'req-1', status: 'rejected', doctor_name: 'Dr Secondary' };
    repo.getRequestById.mockResolvedValue(current);

    const result = await flow.resolve('gs-1', 'approved');

    expect(repo.markDoctorLogSuperseded).toHaveBeenCalledWith('log-1', 'approved');
    expect(result).toEqual({
      outcome: 'late',
      slot: 'primary',
      doctorName: 'Dr Primary',
      doctorMobile: '+911111111111',
      request: current,
    });
  });

  it('returns "duplicate" without re-fetching the request when the reply was already marked late', async () => {
    repo.findDoctorLogByMessageId.mockResolvedValue(log);
    repo.transitionRequestStatus.mockResolvedValue(null);
    repo.markDoctorLogSuperseded.mockResolvedValue(false);

    const result = await flow.resolve('gs-1', 'approved');

    expect(result).toEqual({ outcome: 'duplicate' });
    expect(repo.getRequestById).not.toHaveBeenCalled();
  });
});

describe('escalate', () => {
  it('advances to the next configured slot, pages that doctor, and schedules its own timer', async () => {
    const won = {
      id: 'req-1',
      customer_name: 'Jane Doe',
      customer_phone: '+919999999999',
      products: [{ title: 'Amoxicillin', quantity: 2 }],
      file_url: null,
    };
    repo.transitionRequestStatus.mockResolvedValue(won);
    repo.findAwaitingDoctorLog.mockResolvedValue({ id: 'log-1' });
    gupshupService.sendTemplateMessage.mockResolvedValue({ messageId: 'gs-secondary' });

    const result = await flow.escalate({ requestId: 'req-1', slot: 'primary' });

    expect(repo.transitionRequestStatus).toHaveBeenCalledWith('req-1', 'pending_primary', 'pending_secondary', {});
    expect(repo.markDoctorLogExpired).toHaveBeenCalledWith('log-1');
    expect(gupshupService.sendTemplateMessage).toHaveBeenCalledWith({
      contentVariables: { 1: 'Jane Doe', 2: '+919999999999', 3: 'Amoxicillin (x2)' },
      headerImageUrl: flow.CONSULT_HEADER_IMAGE_URL,
      destination: '+912222222222',
    });
    expect(result).toEqual({ outcome: 'escalated', to: 'secondary' });
  });

  it('re-sends the actual prescription photo (not the generic banner) when the request has one', async () => {
    repo.transitionRequestStatus.mockResolvedValue({
      id: 'req-1',
      customer_name: 'Jane',
      customer_phone: '+91999',
      products: [],
      file_url: 'https://s3.example.com/rx.png',
    });
    repo.findAwaitingDoctorLog.mockResolvedValue(null);
    gupshupService.sendTemplateMessage.mockResolvedValue({ messageId: 'gs-secondary' });

    await flow.escalate({ requestId: 'req-1', slot: 'primary' });

    expect(gupshupService.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ headerImageUrl: 'https://s3.example.com/rx.png' }),
    );
  });

  it('marks the request "failed" without paging anyone once the last configured slot has also timed out', async () => {
    repo.transitionRequestStatus.mockResolvedValue({ id: 'req-1', status: 'failed' });
    repo.findAwaitingDoctorLog.mockResolvedValue({ id: 'log-3' });

    const result = await flow.escalate({ requestId: 'req-1', slot: 'tertiary' });

    expect(repo.transitionRequestStatus).toHaveBeenCalledWith('req-1', 'pending_tertiary', 'failed', {});
    expect(gupshupService.sendTemplateMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'failed' });
  });

  it('is a safe no-op when the request was already resolved before the timer fired', async () => {
    repo.transitionRequestStatus.mockResolvedValue(null);

    const result = await flow.escalate({ requestId: 'req-1', slot: 'primary' });

    expect(repo.findAwaitingDoctorLog).not.toHaveBeenCalled();
    expect(gupshupService.sendTemplateMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'already-resolved' });
  });
});

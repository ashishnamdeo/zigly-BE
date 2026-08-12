const { config } = require('../config/env');

// The fixed, ordered chain this app pages doctors in — Primary first, then
// whichever of Secondary/Tertiary/Quaternary are actually configured. Env
// vars are named per-role rather than as a list, so this mapping is spelled
// out explicitly instead of derived.
const SLOTS = [
  { slot: 'primary', number: () => config.gupshup.sendTo, name: () => config.gupshup.primaryDoctorName },
  { slot: 'secondary', number: () => config.gupshup.sendToSecondary, name: () => config.gupshup.secondaryDoctorName },
  { slot: 'tertiary', number: () => config.gupshup.sendToTertiary, name: () => config.gupshup.tertiaryDoctorName },
  { slot: 'quaternary', number: () => config.gupshup.sendToQuaternary, name: () => config.gupshup.quaternaryDoctorName },
];

// Only slots with a number actually configured take part in the chain — if
// e.g. Tertiary is unset, escalation skips straight from Secondary to Quaternary.
function getConfiguredDoctors() {
  return SLOTS.map(({ slot, number, name }) => ({ slot, number: number(), name: name() })).filter((d) => d.number);
}

// The next configured slot after `slot` in chain order, or null if `slot`
// was the last one configured (nobody left to escalate to).
function nextSlotAfter(slot) {
  const doctors = getConfiguredDoctors();
  const index = doctors.findIndex((d) => d.slot === slot);
  return index >= 0 && index + 1 < doctors.length ? doctors[index + 1] : null;
}

module.exports = { getConfiguredDoctors, nextSlotAfter };

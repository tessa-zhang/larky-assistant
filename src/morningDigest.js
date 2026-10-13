import { runDigest } from './commands.js';
import { getSelf, assertIdentity } from './lark.js';
import { loadRegistry } from './users.js';

const defaultServices = { runDigest, getSelf, assertIdentity, loadRegistry };

async function runForUser({ user, dateKey, digestsInFlight, footerHint }, services) {
  if (digestsInFlight.has(user.openId)) {
    return { openId: user.openId, status: 'busy' };
  }

  digestsInFlight.add(user.openId);
  try {
    const result = await services.runDigest({
      self: user,
      delivery: { as: 'bot', userId: user.openId },
      footerHint,
      ack: false,
      requireChange: false,
      morningDigestDate: dateKey,
    });
    return {
      openId: user.openId,
      status: result.reason === 'already-sent' ? 'already-sent' : 'sent',
      count: result.count,
    };
  } catch (error) {
    return { openId: user.openId, status: 'failed', error };
  } finally {
    digestsInFlight.delete(user.openId);
  }
}

async function resolveGuest(openId, entry, services) {
  const resolved = await services.getSelf(entry.home);
  services.assertIdentity(resolved, openId, `morning-digest:${openId}`);
  return { ...resolved, userName: entry.userName || resolved.userName };
}

/**
 * Deliver one full digest to the owner and every registered user, sequentially.
 * One user's auth or delivery failure never blocks the rest of the cohort.
 */
export async function runMorningDigestBatch({
  owner,
  dateKey,
  digestsInFlight,
  footerHint,
  completedUserIds = new Set(),
}, services = defaultServices) {
  const results = [];

  if (!completedUserIds.has(owner.openId)) {
    results.push(await runForUser({ user: owner, dateKey, digestsInFlight, footerHint }, services));
  }

  let registry;
  try {
    registry = await services.loadRegistry();
  } catch (error) {
    results.push({ openId: null, status: 'registry-failed', error });
    return results;
  }

  for (const [openId, entry] of Object.entries(registry)) {
    if (completedUserIds.has(openId)) continue;
    try {
      const user = await resolveGuest(openId, entry, services);
      results.push(await runForUser({ user, dateKey, digestsInFlight, footerHint }, services));
    } catch (error) {
      results.push({ openId, status: 'failed', error });
    }
  }

  return results;
}

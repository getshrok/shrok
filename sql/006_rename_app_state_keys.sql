-- sql/006_rename_app_state_keys.sql
-- Phase 30: Rename legacy flat AppStateStore keys to default-prefixed equivalents.
-- Prevents a silent notification gap on first post-upgrade boot — without this,
-- threshold-block or rate-limit notifications would be dropped because
-- getLastActiveChannel('default') would return '' until the next user message
-- landed and rewrote the namespaced key.
--
-- Idempotent: if the legacy row is missing (fresh install) or the destination row
-- already exists (re-run after manual fixup), the UPDATE is a no-op. The migration
-- runner's _migrations table also guarantees this file runs at most once.

UPDATE app_state
   SET key = 'default:last_active_channel'
 WHERE key = 'last_active_channel'
   AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = 'default:last_active_channel');

UPDATE app_state
   SET key = 'default:archival_lock'
 WHERE key = 'archival_lock'
   AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = 'default:archival_lock');

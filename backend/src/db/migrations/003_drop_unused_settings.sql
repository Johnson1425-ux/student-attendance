-- =============================================================================
-- 003_drop_unused_settings.sql
--
-- Remove three settings that were surfaced in the admin screen but read by no
-- code path:
--
--   attendance_cutoff_time         — day closing is driven by FINALIZE_CRON and
--                                    the manual "Close the day" action, not by
--                                    a stored time of day.
--   duplicate_punch_window_minutes — repeat scans are already handled: the
--                                    event ledger deduplicates identical
--                                    punches, and minimum_checkout_gap_minutes
--                                    stops a re-tried finger being read as the
--                                    student leaving.
--   school_end_time                — described as governing check-out
--                                    interpretation, which is purely
--                                    gap-based.
--
-- A setting an administrator can change that silently does nothing is worse
-- than no setting at all, so they are dropped rather than left in place.
-- =============================================================================

DELETE FROM settings
 WHERE key IN ('attendance_cutoff_time', 'duplicate_punch_window_minutes', 'school_end_time');

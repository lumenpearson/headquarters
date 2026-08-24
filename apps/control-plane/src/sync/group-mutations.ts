/**
 * The SQL spine every group mutation shares.
 *
 * `revokeDevice` established the discipline: one parameterized statement,
 * data-modifying CTEs, and a fixed lock order of group → membership → session →
 * access token. F6 adds five more mutations that follow it exactly, and writing
 * the spine out five more times is how one corrected lock order becomes five
 * uncorrected ones. The differing middle stays with each mutation; only the
 * parts that must be identical live here.
 *
 * Parameter positions are fixed so a caller can add its own without renumbering
 * the spine:
 *
 * - `$1` group id
 * - `$2` acting device id
 * - `$3` the mutation instant
 * - `$4` receipt scope, or NULL when the caller opted out of retries
 * - `$5` receipt request-id hash, or NULL
 * - `$6` onwards: whatever the mutation itself needs
 */
export const firstGroupMutationParameter = 6;

/**
 * Locks the receipt, the group and the acting membership, and counts the
 * group's remaining administrators.
 *
 * `mutation_gate` is what makes an opted-out caller behave identically to one
 * whose claim is live: with `$5` NULL the gate opens unconditionally, and with
 * a claim it opens only while that claim is uncompleted.
 */
export const groupMutationPrologue = `WITH locked_receipt AS MATERIALIZED (
           -- The claim was committed by its own statement, so the row is
           -- visible here. FOR UPDATE holds it for the duration of this
           -- mutation, which serializes concurrent retries of one request
           -- identifier.
           SELECT receipt.request_id_hash
           FROM mutation_receipts AS receipt
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
             AND receipt.completed_at IS NULL
           FOR UPDATE OF receipt
         ),
         mutation_gate AS MATERIALIZED (
           SELECT 1 AS open FROM locked_receipt
           UNION ALL
           SELECT 1 AS open WHERE $5::text IS NULL
         ),
         locked_group AS MATERIALIZED (
           SELECT
             groups.id,
             groups.name,
             groups.authority_mode,
             groups.leader_device_id,
             groups.revision
           FROM groups
           CROSS JOIN mutation_gate
           WHERE groups.id = $1
           FOR UPDATE OF groups
         ),
         actor AS MATERIALIZED (
           SELECT membership.group_id, membership.device_id, membership.role
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           JOIN locked_group ON locked_group.id = membership.group_id
           WHERE membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
           FOR UPDATE OF membership
         ),
         active_admin_count AS (
           SELECT COUNT(*) AS value
           FROM group_memberships AS membership
           JOIN locked_group ON locked_group.id = membership.group_id
           WHERE membership.role = 'ADMIN'
             AND membership.revoked_at IS NULL
         )`;

/**
 * Bumps the group revision for whatever the mutation's own `applied` CTE
 * produced, then completes the receipt with that revision.
 *
 * Every mutation's `applied` CTE projects the same five columns:
 * `group_id`, `device_id`, `next_name`, `next_authority_mode` and
 * `next_leader_device_id`, with NULL wherever that mutation changes nothing.
 * The single `UPDATE groups` here is why: PostgreSQL gives no defined result
 * when two data-modifying CTEs update the same row, so a mutation that both
 * renamed a group and bumped its revision in two CTEs would silently lose one
 * of the two.
 *
 * `device_id` is carried through because the receipt outcome check requires it
 * for the membership-shaped scopes; the group-shaped ones leave it NULL.
 */
export const groupMutationEpilogue = `,
         updated_group AS (
           UPDATE groups
           SET revision = groups.revision + 1,
               updated_at = $3,
               name = COALESCE(applied.next_name, groups.name),
               authority_mode = COALESCE(applied.next_authority_mode, groups.authority_mode),
               leader_device_id =
                 COALESCE(applied.next_leader_device_id, groups.leader_device_id)
           FROM applied
           WHERE groups.id = applied.group_id
           RETURNING
             groups.id AS group_id,
             groups.name AS group_name,
             groups.authority_mode AS group_authority_mode,
             groups.leader_device_id AS group_leader_device_id,
             groups.revision AS group_revision,
             groups.created_at AS group_created_at,
             groups.updated_at AS group_updated_at
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = updated_group.group_id,
               device_id = applied.device_id,
               revision = updated_group.group_revision,
               completed_at = $3
           FROM updated_group
           CROSS JOIN applied
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )`;

/**
 * The projection every group mutation returns.
 *
 * It is built from scalar subqueries so the statement yields a row even when
 * the gate is shut; the replay path reads `receipt_claimed` explicitly rather
 * than inferring a retry from an empty result.
 */
export const groupMutationProjection = `SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM actor) AS actor_active,
           (SELECT actor.role FROM actor LIMIT 1) AS actor_role,
           EXISTS (SELECT 1 FROM locked_group) AS group_present,
           (SELECT active_admin_count.value FROM active_admin_count) AS active_admin_count,
           (SELECT to_jsonb(updated_group) FROM updated_group) AS group`;

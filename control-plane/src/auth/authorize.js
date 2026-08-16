// Who may do what.
//
// Server-side, per resource, on every request. The dashboard hides buttons a
// user cannot use; that is a courtesy, not a control, and nothing here trusts
// anything the frontend says about a role.
'use strict';

const ROLES = Object.freeze(['owner', 'admin', 'developer', 'viewer']);

// Permissions rather than role checks at call sites: `can(actor, 'preview.redeploy')`
// survives a fifth role being added, `if (role === 'admin')` scattered through
// twenty handlers does not.
const GRANTS = Object.freeze({
  owner:     ['*'],
  admin: [
    'project.view', 'project.update',
    'repository.view', 'repository.connect', 'repository.disconnect',
    'policy.view', 'policy.update',
    'preview.view', 'preview.logs', 'preview.redeploy', 'preview.rollback',
    'preview.destroy', 'preview.pin',
    'audit.view',
  ],
  developer: [
    'project.view', 'repository.view', 'policy.view',
    'preview.view', 'preview.logs', 'preview.redeploy', 'preview.rollback',
    'preview.destroy',
  ],
  viewer: [
    'project.view', 'repository.view', 'policy.view',
    'preview.view',
    // Deliberately no preview.logs. Application logs can contain anything the
    // application logged, including data a reviewer has no business seeing.
    // Being able to use the running application is a weaker permission than
    // being able to read what it printed.
  ],
});

class Forbidden extends Error {
  constructor(permission) {
    super(`not permitted: ${permission}`);
    this.name = 'Forbidden';
    this.status = 403;
    this.permission = permission;
  }
}

class Unauthenticated extends Error {
  constructor() {
    super('authentication required');
    this.name = 'Unauthenticated';
    this.status = 401;
  }
}

/**
 * @param {{userId: string, roleByOrg: Record<string,string>}|null} actor
 * @param {string} permission
 * @param {{organizationId: string}} resource
 */
function can(actor, permission, resource) {
  if (!actor) return false;
  if (!resource || !resource.organizationId) return false;
  const role = actor.roleByOrg[resource.organizationId];
  if (!role) return false;              // not a member: the resource may as well not exist
  const grants = GRANTS[role] || [];
  return grants.includes('*') || grants.includes(permission);
}

function authorize(actor, permission, resource) {
  if (!actor) throw new Unauthenticated();
  if (!can(actor, permission, resource)) throw new Forbidden(permission);
  return true;
}

/**
 * Membership decides visibility, so a listing is filtered rather than checked
 * afterwards. Returning a resource and then refusing to open it still tells the
 * caller it exists, which is a disclosure in its own right.
 */
function visibleOrganizations(actor) {
  return actor ? Object.keys(actor.roleByOrg) : [];
}

module.exports = { ROLES, GRANTS, can, authorize, visibleOrganizations, Forbidden, Unauthenticated };

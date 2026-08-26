/**
 * Where the two prefilled GitHub links point.
 *
 * The slug lived in `components/edit/EditPanel.tsx` under a comment claiming
 * it was "read from `git remote`". It was not, and could not be: the desktop
 * target is a static export with no Node at runtime (ADR 0005), there is no
 * server-side configuration to read one from, and the browser build has no
 * access to a working copy at all. It is a compile-time constant, which is the
 * honest description and also the safe one -- a slug resolved at runtime from
 * whatever remote a machine happened to have would send an operator's issue to
 * a fork, or to someone else's tracker entirely.
 *
 * It is here rather than in a component because R28's translation proposal now
 * needs the same slug as R7's issue draft, and a second literal is how the two
 * links come to point at two repositories.
 */
export const repositorySlug = 'lumenpearson/headquarters';

/**
 * The branch a proposed file is opened against.
 *
 * GitHub's token-less "new file" form needs a branch that already exists; it
 * offers "create a branch and start a pull request" on commit, which is how
 * the operator's proposal becomes a branch of their own without this
 * application ever creating one.
 */
export const repositoryDefaultBranch = 'master';

import type { LucideIcon } from 'lucide-react';
import PermissionLink from '../common/PermissionLink';

export type NavigationChild = {
  to: string;
  label: string;
  icon: LucideIcon;
  external?: boolean;
  reloadDocument?: boolean;
};

export type NavigationGroup = {
  label: string;
  icon: LucideIcon;
  children: NavigationChild[];
};

type NavigationTreeProps = {
  currentHash: string;
  currentPath: string;
  groups: NavigationGroup[];
  onNavigate?: () => void;
};

function isRouteActive(to: string, currentPath: string, currentHash: string) {
  const [targetPath, targetHash = ''] = to.split('#');
  if (targetHash) {
    return currentPath === targetPath && currentHash === `#${targetHash}`;
  }
  return currentPath === targetPath;
}

export function NavigationTree({ currentHash, currentPath, groups, onNavigate }: NavigationTreeProps) {
  return (
    <div className="main-navigation__groups">
      {groups.map((group) => {
        const GroupIcon = group.icon;
        return (
          <section className="main-navigation__group" key={group.label}>
            <div className="main-navigation__group-label">
              <GroupIcon aria-hidden="true" />
              <span>{group.label}</span>
            </div>
            <div className="main-navigation__links">
              {group.children.map((child) => {
                const ChildIcon = child.icon;
                const active = isRouteActive(child.to, currentPath, currentHash);
                const content = (
                  <>
                    <ChildIcon aria-hidden="true" />
                    <span>{child.label}</span>
                  </>
                );

                if (child.external) {
                  return (
                    <a
                      className={`main-navigation__link${active ? ' is-active' : ''}`}
                      href={child.to}
                      key={child.to}
                      onClick={onNavigate}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {content}
                    </a>
                  );
                }

                return (
                  <PermissionLink
                    activeClassName={active ? 'is-active' : ''}
                    ariaCurrent={active ? 'page' : undefined}
                    className="main-navigation__link"
                    key={child.to}
                    onClick={onNavigate}
                    reloadDocument={child.reloadDocument}
                    to={child.to}
                  >
                    {content}
                  </PermissionLink>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

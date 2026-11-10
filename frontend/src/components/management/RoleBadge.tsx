import { Crown, Shield } from 'lucide-react';
import { organizationRoleLabel } from '../../lib/adminAccess';
import { Badge } from '../ui';

/** OWNER / ADMIN / MEMBER as a labelled badge (text carries the meaning, the icon is decorative). */
export const RoleBadge = ({ role }: { role: string | null | undefined }) => {
  const label = organizationRoleLabel(role);
  if (role === 'OWNER')
    return (
      <Badge tone="brand">
        <Crown size={10} aria-hidden="true" />
        {label}
      </Badge>
    );
  if (role === 'ADMIN')
    return (
      <Badge tone="success">
        <Shield size={10} aria-hidden="true" />
        {label}
      </Badge>
    );
  return <Badge>{label}</Badge>;
};

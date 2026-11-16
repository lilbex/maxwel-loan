import { redirect } from 'next/navigation';
import { currentUser, serverApi } from '@/lib/api';
import { StaffForm } from './staff-form';

export default async function StaffPage() {
  const [api, me] = await Promise.all([serverApi(), currentUser()]);
  if (!me.permissions.includes('users.read')) redirect('/');
  const [staff, roles] = await Promise.all([api.staff(), api.roles()]);

  return (
    <>
      <h1 className="page-title">Staff</h1>
      <div className="sheet-scroll">
        <table className="sheet">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Roles</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => (
              <tr key={member.id}>
                <td>{member.fullName}</td>
                <td>{member.email}</td>
                <td>{member.roles.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {me.permissions.includes('users.manage') && <StaffForm roles={roles} />}
    </>
  );
}

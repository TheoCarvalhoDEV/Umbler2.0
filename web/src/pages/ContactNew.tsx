import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../lib/api';
import { ContactForm } from '../components/contacts/ContactForm';

export function ContactNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="mb-6 text-xl font-semibold">Novo contato</h1>
      <ContactForm
        onCancel={() => navigate('/contacts')}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: qk.contactList({}) });
          navigate('/contacts');
        }}
      />
    </div>
  );
}

import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../lib/api';
import { ContactForm } from '../components/contacts/ContactForm';
import { card, pageTitle } from '../components/ui';

export function ContactNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <div className={`${card} h-full overflow-y-auto`}>
      <div className="mx-auto max-w-2xl px-[18px] py-[22px]">
        <h1 className={`${pageTitle} mb-6`}>Novo contato</h1>
        <ContactForm
          onCancel={() => navigate('/contacts')}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: qk.contactList({}) });
            navigate('/contacts');
          }}
        />
      </div>
    </div>
  );
}

# Aceite manual: compromissos

Roteiro do §8 da [especificação](../specs/2026-10-21-compromissos-design.md). Rode no ambiente local, com o número de teste e um segundo celular fazendo o papel do cliente.

> ⚠️ Use só o **número de teste**. Se você ler o QR com o número do escritório, ele sai do Umbler Talk na hora.

## 0. Antes de começar

- [ ] Testes automáticos passando:

```bash
npm test
npm run typecheck
```

- [ ] O ambiente local está rodando (`npm run dev:up` e `npm run dev`), o servidor reiniciou depois da migração `0009_compromissos`, e o canal do número de teste aparece como **Conectado**.
- [ ] Existe uma conversa aberta com o celular do "cliente", atribuída a você, e o contato tem **nome** cadastrado.
- [ ] A sua assinatura está preenchida em **Ajustes → Perfil**.
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`

## 1. Lembretes padrão

- [ ] Como administrador, abra **Ajustes → Compromissos**. Aparecem "2 dias antes" e "1 hora antes" com os textos padrão, cada um com "Vai sair assim: …".

## 2. Compromisso na conversa

- [ ] Na conversa de teste, clique em **Compromissos** (no cabeçalho, ao lado de Contato). O diálogo "Compromissos de <cliente>" diz "Nenhum compromisso marcado com este cliente.".
- [ ] Clique em **Novo compromisso**. Título "Audiência teste", data e hora = agora + 1 h 05 min (horário de Cuiabá), os dois lembretes padrão.
- [ ] Antes de salvar, a linha "2 dias antes" diz "Não será enviado: o horário de envio já passou".
- [ ] Salve. A linha do tempo mostra "Compromisso “Audiência teste” marcado por <você> para <data>".
- [ ] Acima do compositor aparece "1 mensagem agendada". Aberta, a linha mostra "Lembrete · Audiência teste" no lugar de Editar/Cancelar.
- [ ] Em **Agenda → Mensagens → Pendentes**, o lembrete aparece com "Lembrete · Audiência teste" e sem Editar/Cancelar.
- [ ] Em até 5 minutos, o celular do cliente recebe o texto com o nome, a data e a hora certos, com a sua assinatura; no sistema a bolha tem a marca **Agendada**.

## 3. Remarcar

- [ ] Crie "Remarcação teste" para agora + 1 h 10 min, só com "1 hora antes".
- [ ] Em **Compromissos**, clique em **Editar** e mude a hora para agora + 1 h 20 min. Salve.
- [ ] A Agenda mostra o lembrete no horário novo, e a linha do tempo mostra "Compromisso “Remarcação teste” remarcado por <você> para <data>".
- [ ] O cliente recebe a mensagem **uma vez só**, no horário novo.

## 4. Cancelar

- [ ] Crie "Cancelamento teste" para amanhã, com "1 hora antes". Em **Compromissos**, clique em **Cancelar**: aparece "Cancelar o compromisso?" com "Os lembretes que ainda não saíram não serão enviados.". Clique em **Cancelar compromisso**.
- [ ] O lembrete vai para **Agenda → Mensagens → Canceladas**, e o compromisso para **Agenda → Compromissos → Cancelados**, com a marca "Cancelado".

## 5. Pela Agenda, com a conversa finalizada

- [ ] Finalize a conversa de teste.
- [ ] Em **Agenda → Compromissos**, clique em **Novo compromisso**. Em **Cliente**, digite duas letras do nome do cliente e escolha-o. Título "Retorno teste", agora + 1 h 05 min, só "1 hora antes".
- [ ] Em até 5 minutos, o lembrete abre uma conversa nova no mesmo setor, com você como atendente, e o cliente recebe a mensagem.

## 6. Abas e assinatura

- [ ] Na Agenda, alterne entre **Mensagens** e **Compromissos**: cada aba volta no filtro em que estava.
- [ ] Na conversa, em **Compromissos**, o link **Ver todos os compromissos** abre a Agenda já na aba Compromissos.
- [ ] Crie um compromisso para agora + 1 h 05 min, com "1 hora antes" e **Enviar com minha assinatura** desmarcada: o lembrete chega ao cliente **sem** assinatura.

## Resultado

- [ ] Tudo certo → anote "aceite ok <versão>" no PR.
- Problemas encontrados: `________`

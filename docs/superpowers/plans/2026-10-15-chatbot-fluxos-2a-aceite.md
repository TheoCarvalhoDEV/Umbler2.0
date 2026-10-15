# Aceite manual: chatbot "Fluxo do escritório" (entrega 2a)

Roteiro do critério 1 do §1 da [especificação](../specs/2026-10-15-chatbot-fluxos-2a-design.md). O modelo "Fluxo do escritório" precisa rodar de ponta a ponta no ambiente local, com o número de teste. O cliente passa por horário e dia, boas-vindas, menu e comunicado. Depois informa o CPF, que é validado e salvo no campo. A conversa então cai no setor certo e o atendente é notificado.

> ⚠️ Use só o **número de teste**. Se você ler o QR com o número do escritório, ele sai do Umbler Talk na hora.
> Para o CPF, use o número de teste `529.982.247-25`. Ele é válido no dígito verificador, mas não é de ninguém. Nunca use o CPF de um cliente.

## 0. Antes de começar

- [ ] Testes automáticos passando, incluindo o de ponta a ponta do modelo:

```bash
npm test
npm test -w server -- test/bots/template.test.ts
```

- [ ] O ambiente local está rodando, conforme o README ("Rodar localmente"): `npm run dev:up`, `npm run dev` e o administrador criado.
- [ ] Em Configurações › Canais, o canal do **número de teste** aparece como **Conectado**.
- [ ] Os setores **Atendimento**, **Financeiro** e **Processos** estão criados.
- [ ] Existe um usuário atendente, aqui chamado de "Atendente Teste", que participa dos três setores.
- [ ] O admin enxerga todas as conversas, porque entrou nos três setores ou ligou **Ver todos os setores** na caixa de entrada.
- [ ] Configurações › Conversas: "Quando o atendente enviar mensagem com chatbot em execução" está em **Perguntar**.
- [ ] O celular do "cliente" (outro número) tem um nome no perfil do WhatsApp e **não** tem conversa aberta no sistema. Se tiver, finalize a conversa.
- [ ] Duas janelas do navegador estão abertas:
  - uma normal, com o admin;
  - uma anônima (`Ctrl+Shift+N`), com o Atendente Teste, para ver o aviso.
- [ ] A hora está dentro do horário do modelo: **seg–sex, 08:00–12:00 ou 14:00–18:00 no horário de Cuiabá** (em Brasília, 09:00–13:00 ou 15:00–19:00).
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`

Regra entre as partes: no fim de cada parte, **finalize** a conversa (sem mensagem de encerramento). Assim a próxima mensagem do cliente abre uma conversa nova e o chatbot começa de novo.

## A. Criar e ativar o modelo

1. [ ] Admin: Configurações › **Chatbots** › **Criar a partir do modelo**.
2. [ ] Preencha:
   - **Nome do escritório:** `Escritório Teste`;
   - **Canal:** o canal de teste;
   - **Destinos:** Atendimento → setor Atendimento e Atendente Teste; Financeiro → setor Financeiro e Atendente Teste; Processos → setor Processos e Atendente Teste.

   Depois clique em criar.
3. [ ] Esperado:
   - a lista mostra **Fluxo do escritório**, pausado, com o canal de teste;
   - em Configurações › Campos personalizados existe **um** campo **CPF**, sem duplicar se ele já existia.
4. [ ] Abra o fluxo no editor. Esperado:
   - os blocos estão ligados, de **Iniciar por um canal** → **Horário** até os blocos de transferência e aviso;
   - nenhum bloco aparece em vermelho;
   - em **Versões**, a versão 1 está publicada.

   Saia sem mexer em nada.
5. [ ] Na lista, clique em **Ativar**. Esperado: o fluxo aparece como ativo.

## B. Dentro do horário: opção pelo número, CPF errado e depois certo

1. [ ] O cliente envia `Oi`.
2. [ ] O cliente recebe, nesta ordem, e **não** recebe o menu da triagem simples:
   - `Olá <primeiro nome>! 👋 Sou o assistente virtual da Escritório Teste. Como posso te ajudar hoje?`
   - `Escolha uma das opções abaixo digitando o número correspondente:`, seguido das linhas `1: Atendimento`, `2: Financeiro` e `3: Processos`.
3. [ ] No sistema, na conversa nova:
   - as duas mensagens aparecem com o ícone de robô e **Chatbot Fluxo do escritório**;
   - a linha do tempo mostra `Chatbot Fluxo do escritório iniciado`.
4. [ ] O cliente envia `2`. Ele recebe o comunicado (`⚠️ COMUNICADO — Informamos que nosso WhatsApp está com uma demanda muito alta…`) e depois `Para agilizar, digite seu CPF:`.
5. [ ] O cliente envia `123`. Ele recebe `CPF inválido, confira e digite de novo.`
6. [ ] Na janela do Atendente Teste, deixe a caixa de entrada aberta. O cliente envia `529.982.247-25`. Esperado: o cliente não recebe mais nada.
7. [ ] No sistema, esperado:
   - a conversa está no setor **Financeiro**, com o atendente **Atendente Teste**;
   - a linha do tempo mostra `Chatbot Fluxo do escritório transferiu para Financeiro`, depois a mesma frase com ` · Atendente Teste`, e por fim `Chatbot Fluxo do escritório finalizado`;
   - a ficha do contato mostra **CPF** = `529.982.247-25`.
8. [ ] Na janela do Atendente Teste aparece o aviso **Nova conversa**, com `Nova conversa de <nome do cliente> — CPF 529.982.247-25`. Clicar no aviso abre a conversa.
9. [ ] Finalize a conversa.

## C. Fora do horário, e voltar a versão

1. [ ] No editor, no bloco **Horário**, troque o intervalo por um que não inclua a hora atual, por exemplo 03:00–04:00, e clique em **Salvar e publicar**. Esperado: em **Versões**, a versão 2 está publicada.
2. [ ] O cliente envia `Oi`. Ele recebe só `Estamos fora do horário de atendimento. Deixe sua mensagem que retornaremos assim que possível.`, sem boas-vindas e sem menu.
3. [ ] No sistema, esperado:
   - a conversa continua **aberta** na Entrada, no setor padrão e sem atendente, ou seja, **não** foi finalizada;
   - a linha do tempo mostra `… iniciado` e `… finalizado`.
4. [ ] No editor, abra **Versões**, escolha a versão 1, restaure-a como novo rascunho e clique em **Salvar e publicar**. Esperado:
   - a versão 3 está publicada;
   - o bloco **Horário** voltou a seg–sex, 08:00–12:00 e 14:00–18:00.
5. [ ] Finalize a conversa.

## D. Opção pelo nome, atendente escreve com o bot rodando, reinício do servidor

1. [ ] O cliente envia `Oi` e recebe as boas-vindas e o menu.
2. [ ] O admin digita `Teste do atendente` na conversa e envia. Esperado: abre o diálogo **O chatbot está rodando**. Clique em **Cancelar**. Esperado: nada é enviado.
3. [ ] O admin envia de novo e escolhe **Enviar e manter**. Esperado: o cliente recebe a mensagem do admin, com assinatura, e o chatbot continua esperando a escolha.
4. [ ] O cliente envia `processos`, em minúsculas e escrito por extenso. Ele recebe o comunicado e o pedido de CPF.
5. [ ] Reinicie o servidor: `Ctrl+C` no terminal do `npm run dev` e depois `npm run dev` de novo. Espere a API subir. Recarregue as duas janelas do navegador.
6. [ ] O cliente envia `52998224725`, só os dígitos. Esperado:
   - a conversa está em **Processos**, com o Atendente Teste;
   - o aviso mostra `CPF 529.982.247-25`, já formatado;
   - a linha do tempo termina em `… finalizado`.
7. [ ] No terminal do `npm run dev`, procure `529.982.247-25`, `52998224725` e `Teste do atendente`. **Nenhum** deles pode aparecer, porque o log mostra só nomes, ids e códigos de erro.
8. [ ] Finalize a conversa.

## E. Opção inválida e CPF inválido três vezes

1. [ ] O cliente envia `Oi` e recebe as boas-vindas e o menu.
2. [ ] O cliente envia `9`. Ele recebe o aviso de opção inválida (o padrão é `Opção inválida.`) e o menu de novo.
3. [ ] O cliente envia `1`. Ele recebe o comunicado e o pedido de CPF.
4. [ ] O cliente envia `abc` três vezes. Ele recebe `CPF inválido, confira e digite de novo.` depois da 1ª e da 2ª vez. Depois da 3ª, não recebe nada.
5. [ ] Esperado:
   - o fluxo segue mesmo assim: a conversa vai para **Atendimento**, com o Atendente Teste;
   - o aviso diz `Nova conversa de <nome> — CPF `, com o CPF vazio, porque nenhum CPF válido foi digitado nesta conversa;
   - a ficha do contato continua com o CPF da parte B.
6. [ ] Finalize a conversa.

## F. Parar o chatbot pela conversa

1. [ ] O cliente envia `Oi` e recebe as boas-vindas e o menu.
2. [ ] Na conversa, o admin clica no botão de robô do compositor e depois em **Parar chatbot**. Esperado: a linha do tempo mostra `Chatbot Fluxo do escritório parado por <nome do admin>`.
3. [ ] O cliente envia `2`. Esperado: o chatbot não responde e a conversa continua na Entrada para os atendentes.
4. [ ] Finalize a conversa.

## Resultado

| Data | Quem testou | Versão (`git log -1 --format=%h`) | A | B | C | D | E | F | Observações |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

O critério 1 só está cumprido com **todas** as partes marcadas. Se alguma falhar, anote o passo e o que apareceu. Não anote textos de clientes nem CPFs reais.

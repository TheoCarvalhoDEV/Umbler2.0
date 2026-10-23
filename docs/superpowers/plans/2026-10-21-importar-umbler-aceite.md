# Aceite manual: Importar do Umbler

Roteiro do §15 da [especificação](../specs/2026-10-21-importar-umbler-design.md). Primeiro no **ambiente de teste**; em produção, no dia da virada, o roteiro da seção 5 do [IMPLANTACAO.md](../../IMPLANTACAO.md) e as mesmas conferências por amostragem.

> ⚠️ O ambiente de teste recebe dados reais de clientes: HTTPS, senhas fortes e acesso restrito, como a produção. Ninguém responde cliente pelo número de teste. No fim, o ambiente é apagado.

## 0. Antes de começar

- [ ] Testes automáticos passando: `npm test`.
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`
- [ ] No Umbler, anote 3 conversas **abertas com não lidas** e o número do badge de cada uma: `________`, `________`, `________`.
- [ ] Anote as contagens do Umbler: Entrada `____`, Esperando `____`, Finalizados `____` (≈ 9440), Contatos `____` (≈ 2368).

## A. Token e análise

- [ ] Ajustes › Importar do Umbler, sem token: "Token do Umbler não configurado. Coloque UMBLER_TOKEN no arquivo .env do servidor e reinicie o sistema." e **Analisar** desabilitado.
- [ ] Token do Proprietário no `.env` de teste (IMPLANTACAO §5, passo 2): aparece "Token do Umbler configurado." e nenhum pedaço do token.
- [ ] Com as Regras automáticas ligadas, **Analisar** e veja o bloqueio "Desligue as Regras automáticas antes de importar…" com **Importar** desabilitado. Desligue-as e volte à tela: o bloqueio some.
- [ ] "Analisando o Umbler… N conversas lidas" e, em cerca de 1 minuto, "O que foi encontrado": as contagens batem com as anotadas (Finalizados, Contatos, abertas e esperando).
- [ ] O teste de leitura não bloqueou (nenhum aviso "A leitura marcou uma conversa como lida no Umbler…").
- [ ] Canais: o canal do Umbler → **canal de teste** (de propósito). Setores e atendentes conferidos; ex-atendentes em "Criar usuário inativo".
- [ ] Os avisos fazem sentido (espaço livre em disco, limite do plano, token sem acesso total, se houver).

## B. Importação

- [ ] **Importar** → confirmação "Importar N contatos e N conversas do Umbler? A cópia roda em segundo plano e pode levar algumas horas." → **Importar**.
- [ ] A tela mostra "Etapa 3 de 5: conversas abertas — x de y" e os contadores subindo; fechar e reabrir a tela não muda nada.
- [ ] Durante as conversas finalizadas, reinicie o servidor (`docker compose restart app`): a importação continua sozinha, sem duplicar (contadores seguem de onde estavam).
- [ ] Ao fim: "Importação concluída em dd/mm/aaaa hh:mm (duração …)." e o relatório.

## C. O que chegou

- [ ] Abertas na **Entrada** com o mesmo setor, atendente e "esperando" do Umbler; as de ex-atendentes na fila do setor ("Sem atendente").
- [ ] Finalizadas em **Finalizados** com as datas originais; a linha do tempo diz "Conversa importada do Umbler Talk: N mensagens" e "Conversa finalizada por X".
- [ ] Uma conversa com foto, áudio e PDF abre os três arquivos; um arquivo que o Umbler não tem mais mostra "Arquivo não está mais disponível…".
- [ ] Notas internas aparecem como notas; observações do contato aparecem na ficha, com autor e data.
- [ ] Respostas rápidas com anexo funcionam; as "apenas para mim" de um atendente ativo ficam só dele.
- [ ] Ex-atendentes aparecem em Ajustes › Atendentes como **inativos** e não conseguem entrar.
- [ ] Nada disparou: nenhuma triagem, chatbot, aviso ou mensagem ao WhatsApp; finalizadas sem não lidas.

## D. O Umbler não mudou

- [ ] As 3 conversas anotadas continuam com o **mesmo badge** de não lidas; nada mudou de estado.
- [ ] A tela "sendo utilizado em mais de um dispositivo" não apareceu no Umbler.
- [ ] Atividades do Umbler sem entradas novas do token.

## E. Encerramento do ensaio

- [ ] Relatório revisado (casadas com o histórico, maior diferença, arquivos indisponíveis).
- [ ] Ninguém respondeu cliente pelo número de teste.
- [ ] Token apagado no Umbler e tirado do `.env`.
- [ ] Ambiente de teste apagado: `docker compose down -v` e a pasta `data/media`.

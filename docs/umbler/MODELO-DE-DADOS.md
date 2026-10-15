# Modelo de dados (extraído da spec pública da API)

Fonte: `utalk-openapi-v1.json` (OAS 3.0.4, 951 schemas) — sem nenhum dado de cliente. Gerado por script a partir dos schemas usados nas respostas de `chats/{id}`, `messages`, `contacts`, etc.
Os mesmos objetos trafegam em `/internal-api` (as rotas espelham a API pública); o formato das mensagens Ably **não** foi verificado — a captura com corpo foi bloqueada pelo controle de dados pessoais.
Tipos terminados em `?` são anuláveis; `A | B` = polimórfico (campo `_t` discrimina).

## Conversa e mensagens
### BasicChatModel
Herda: ModelBase
| campo | tipo |
|---|---|
| _t | string |
| organization | OrganizationReferenceIdModel |
| contact | ContactReferenceModel |
| channel | ChatChannelReferenceBaseModel | ChatBrokerWhatsappChannelReferenceModel | ChatCloudAPIWhatsappChannelReferenceModel | ChatExternalChannelReferenceBaseModel | ChatGupshupInstagramChannelReferenceModel | ChatGupshupWhatsappChannelReferenceModel | ChatInstagramChannelReferenceBaseModel | ChatInternalChannelReferenceBaseModel | ChatMembersChannelReferenceModel | ChatPhoneNumberChannelReferenceBaseModel | ChatUsernameChannelReferenceBaseModel | ChatWebsiteWidgetChannelReferenceModel | ChatWelcomerChannelReferenceModel | ChatWhatsappChannelReferenceBaseModel |
| sector | SectorReferenceModel |
| sectorHistory | SectorHistoryReferenceModel[] |
| organizationMember | ChatAgentReferenceModel |
| organizationMembers | ChatAgentReferenceModel[] |
| organizationMemberHistory | ChatMemberReferenceModel[] |
| tags | SimpleTagReferenceModel | TagModel[] |
| lastMessage | MessageModel | SentMessageModel |
| lastMessageReaction | MessageReactionModel |
| redactReason | RedactReason |
| usingInactivityFlow | boolean? |
| usingWaitingFlow | boolean? |
| inactivityFlowAt | string(date-time)? |
| waitingFlowAt | string(date-time)? |
| open | boolean |
| private | boolean |
| waiting | boolean |
| waitingSinceUTC | string(date-time)? |
| totalUnread | integer(int32) |
| totalAIResponses | integer(int32)? |
| closedAtUTC | string(date-time)? |
| closedBy | SimpleAgentReferenceModel |
| eventAtUTC | string(date-time) |
| firstMemberReplyMessage | MessageReferenceModel | MessageForwardedReferenceModel |
| firstContactMessage | MessageReferenceModel | MessageForwardedReferenceModel |
| bots | BotInstanceChatDataModel[] |
| lastOrganizationMember | AgentReferenceIdModel |
| message | MessageModel | SentMessageModel |
| visibility | ChatVisibility |
| favoriteMessages | string[] |

### ChatModel
Herda: BasicChatModel
| campo | tipo |
|---|---|
| hasMessagesBeforeAllowedHistory | boolean |
| latestMessages | MessagePartModel | MessageModel | SentMessageModel | AutomationFlowExecutedMetadataModel | BotErrorMetadataModel | BotManuallyStartedMetadataModel | BotScheduledMetadataModel | BotStartedMetadataModel | BotStoppedMetadataModel | ChannelTransferMetadataModel | ChatClosedMetadataModel | ChatCreatedMetadataModel | ChatPrivateChangedMetadataModel | ChatReassignBotStartedMetadataModel | ChatReopenedMetadataModel | ChatVisibilityChangedMetadataModel | ChatWaitingChangedMetadataModel | ContactFieldEditedMetadataModel | CustomFieldEditedMetadataModel | MemberTransferMetadataModel | MetadataBaseModel | ScheduledMessageChangedMetadataModel | SectorTransferMetadataModel | TagsChangedMetadataModel[] |

### MessagePartModel
Herda: ModelBase
| campo | tipo |
|---|---|
| _t | string |
| eventAtUTC | string(date-time) |

### MessageModel
Herda: MessagePartModel
| campo | tipo |
|---|---|
| _t | string |
| prefix | string? |
| headerContent | string? |
| content | string? |
| footer | string? |
| file | MessageFileModel |
| thumbnail | MessageFileModel |
| quotedStatusUpdate | MessageFileModel |
| contacts | ChatContactModel[] |
| messageType | MessageTypes |
| sentByOrganizationMember | AgentReferenceIdModel |
| isPrivate | boolean |
| location | LocationModel |
| question | BotQuestionModel | ObjectiveBotQuestionModel | SubjectiveQuestionModel |
| source | MessageSources |
| inReplyTo | MessageReplyReferenceModel |
| messageState | MessageStates |
| chat | ChatIdReferenceModel |
| fromContact | ContactReferenceIdModel |
| templateId | string? |
| whatsappFlow | MessageFlowModel |
| whatsappFlowReply | FlowMessageReplyModel |
| catalog | MessageCatalogModel |
| buttons | MessageButtonModel[] |
| latestEdit | LatestEditModel |
| botInstance | BotInstanceReferenceModel | ScheduledMessageBotReferenceModel |
| forwardedFrom | MessageForwardedReferenceModel |
| forwardCount | integer(int32) |
| frequentlyForwarded | boolean |
| isForwardRestricted | boolean |
| scheduledMessage | ScheduledMessageReferenceIdModel |
| bulkSendSession | BulkSendSessionReferenceModel |
| elements | string? |
| mentions | MessageMentionModel[] |
| ad | AdModel |
| fileId | string? |
| reactions | MessageReactionModel[] |
| deductedAiCredits | integer(int32)? |
| isFavorite | boolean? |
| carousel | MessageCarouselModel[] |
| billable | MessageBillableModel |
| linkPreview | LinkPreviewModel |
| linkPreviewAttemptedAtUTC | string(date-time)? |

### SentMessageModel
Herda: MessageModel
| campo | tipo |
|---|---|
| contactId | string |

### MessageFileModel
| campo | tipo |
|---|---|
| url | string(uri)? |
| contentType | string? |
| originalName | string? |
| originalSizeBytes | integer(int64)? |
| data | string(byte)? |
| failDownload | boolean |
| caption | string? |
| transcription | string? |
| versions | FileVersionModel[] |

### MessageStates
Enum: `Processing`, `Sent`, `Received`, `Read`, `Redacted`, `Failed`, `Deleted`, `Submitted`, `Played`, `Edited`, `Reaction`, `Retrying`, `Error`

### MessageSources
Enum: `Contact`, `Member`, `External`, `Bot`

### MessageTypes
Enum: `Text`, `Image`, `Video`, `Audio`, `Sticker`, `Location`, `Contact`, `File`, `Payment`, `List`, `ListReply`, `CallAttempt`, `QuickReply`, `Poll`, `Gif`, `Reaction`, `Order`, `ButtonReply`, `Carousel`, `Unsupported`, `Url`

### ChatState
Enum: `Open`, `Closed`, `All`

### ChatVisibility
Enum: `Show`, `Hide`, `HideUntilNextMessage`

### ContactType
Enum: `DirectMessage`, `Group`, `MemberDirectMessage`, `MemberGroup`, `PrivateMemberGroup`, `AIAssistant`, `Sandbox`

## Eventos de sistema na conversa (metadados)
### MetadataBaseModel
Herda: MessagePartModel
| campo | tipo |
|---|---|
| _t | string |
| author | AuthorBaseModel | AgentAuthorModel | BotAuthorModel | ContactAuthorModel | SystemAuthorModel |

### ChatCreatedMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|

### ChatClosedMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| causedBy | ChatModificationCause |

### ChatReopenedMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|

### ChatPrivateChangedMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| isPrivate | boolean |

### ChatVisibilityChangedMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| visible | boolean |
| visibility | ChatVisibility |

### ChatWaitingChangedMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| waiting | boolean |

### MemberTransferMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| previousMemberId | string? |
| newMemberId | string? |
| userProvidedReason | string? |
| causedBy | ChatModificationCause |
| reassignReason | ReassignOptions |

### SectorTransferMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| previousSectorId | string |
| newSectorId | string |
| userProvidedReason | string? |
| causedBy | ChatModificationCause |

### ChannelTransferMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| counterpartChatId | string |
| counterpartChannelId | string |
| direction | ChannelTransferDirections |
| userProvidedReason | string? |

### TagsChangedMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| addedTagIds | string[] |
| removedTagIds | string[] |
| target | TagChangeTargets |
| causedBy | ChatModificationCause |

### BotStartedMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| botId | string |
| botTitle | string? |
| triggerName | string? |

### BotStoppedMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| botId | string |
| botInstanceId | string |

### BotErrorMetadataModel
Herda: MetadataBaseModel
| campo | tipo |
|---|---|
| error | BotErrors |
| incidentId | string? |
| details | string? |

## Contatos, organização e cadastros
### ContactModel
Herda: SimpleContactModel
| campo | tipo |
|---|---|
| notes | NoteModel[] |

### ChatContactModel
| campo | tipo |
|---|---|
| name | string? |
| addresses | AddressModel[] |
| phoneNumbers | string[] |
| company | string? |
| emails | string[] |
| profilePictureBlob | string? |

### OrganizationAgentModel
Herda: ModelBase
| campo | tipo |
|---|---|
| _t | string |
| displayName | string? |
| signature | string? |
| profilePictureUrl | string(uri)? |
| organizations | OrganizationReferenceModel | OrganizationReferenceForAITalkAgentModel | OrganizationReferenceForHumanAgentModel[] |

### AgentReferenceModel
Herda: IdentifierReferenceBaseModel
| campo | tipo |
|---|---|
| _t | string |
| displayName | string |

### SectorReferenceModel
Herda: ReferenceBaseModel
| campo | tipo |
|---|---|
| default | boolean |
| order | number(float) |
| groupIds | string[] |

### TagModel
Herda: SimpleTagReferenceModel
| campo | tipo |
|---|---|
| emoji | string? |
| color | TagColor |
| description | string? |
| order | number(float) |
| createdAtUTC | string(date-time) |
| groupIds | string[] |

### SimpleQuickAnswerModel
Herda: ModelBase
| campo | tipo |
|---|---|
| name | string |
| content | string |
| organizationMember | QuickAnswerAgentReferenceModel |
| createdBy | QuickAnswerAgentReferenceModel |
| groupIds | string[] |
| variables | QuickAnswerVariableModel[] |
| attachment | QuickAnswerAttachmentModel |

### ScheduledMessageModel
Herda: ModelBase
| campo | tipo |
|---|---|
| status | ScheduledMessageStatus |
| templateId | string? |
| templateLabel | string? |
| bot | ScheduledMessageBotReferenceModel |
| params | string[] |
| message | string? |
| dateSendAtUtc | string(date-time) |
| contact | ScheduledMessageContactReferenceModel |
| channel | ScheduledMessageChannelReferenceModel |
| messageReference | MessageReferenceModel | MessageForwardedReferenceModel |
| organizationMember | AgentReferenceIdModel |
| cancelUpon | CancelScheduledMessageUpon[] |
| prefix | string? |
| initialData | object? |
| botInstance | BotInstanceReferenceModel | ScheduledMessageBotReferenceModel |
| bulkSession | string? |
| fileId | string? |
| cancelReason | ScheduledMessageCanceledReason |
| canceledAtUTC | string(date-time)? |
| isPrivate | boolean |

### ChannelBaseModel
Herda: ModelBase
| campo | tipo |
|---|---|
| _t | string |
| displayName | string |
| pictureUrl | string(uri)? |
| defaultSector | SectorReferenceModel |
| defaultBusinessHour | BusinessHourReferenceModel |
| state | ChannelState |
| organization | OrganizationReferenceIdModel |
| deleteReason | string? |

### WebhookModel
Herda: ModelBase
| campo | tipo |
|---|---|
| name | string |
| url | string |
| failuresToday | integer(int32) |
| failuresByReasonToday | WebhookDailyFailuresModel |
| paused | boolean |
| pausedDueToFailures | boolean |
| forChannels | string[] |
| events | EventWebhookType[] |

### WebhookActionModel
Herda: FlowchartBotStepModel
| campo | tipo |
|---|---|
| _t | string |
| uri | string |
| method | WebhookMethod |
| headers | FlowchartHeaderModel[] |
| responseMessageMapper | FlowchartResponseModel[] |
| requestContent | string? |
| onSuccess | string? |
| onFail | string? |

### WebhookMethod
Enum: `Post`, `Put`, `Get`, `Patch`

## Bases e enums complementares
### ModelBase
| campo | tipo |
|---|---|
| _t | string |
| id | string |
| createdAtUTC | string(date-time) |

### SimpleContactModel
Herda: ModelBase
| campo | tipo |
|---|---|
| _t | string |
| name | string? |
| phoneNumber | string? |
| lid | string? |
| whatsAppUsername | string? |
| email | string? |
| landline | string? |
| gender | string? |
| address | AddressModel |
| profilePictureUrl | string(uri)? |
| isBlocked | boolean |
| groupIdentifier | string? |
| contactType | ContactType |
| organizationMembers | string[] |
| channelIds | string[] |
| tags | SimpleTagReferenceModel | TagModel[] |
| lastActiveUTC | string(date-time)? |
| channels | ContactChannelModel[] |
| customFields | ContactCustomFieldModel | ContactCNPJCustomFieldModel | ContactCPFCustomFieldModel | ContactContactReferenceCustomFieldModel | ContactCurrencyCustomFieldModel | ContactDateCustomFieldModel | ContactDecimalCustomFieldModel | ContactLinkCustomFieldModel | ContactLogicCustomFieldModel | ContactMemberCustomFieldModel | ContactMultiOptionsCustomFieldModel | ContactNumberCustomFieldModel | ContactTextCustomFieldModel | ContactListFileCustomFieldModel | ContactListContactReferenceCustomFieldModel | ContactListMemberCustomFieldModel | ContactDictionaryCustomFieldModel | ContactListStringCustomFieldModel[] |
| relativeCursor | string? |

### EventWebhookType
Enum: `Message`, `MemberTransfer`, `ChatClosed`, `ChatSectorChanged`, `ChatPrivateStatusChanged`, `MessageFileUploaded`, `ChatTagChanged`, `NewChat`

### RedactReason
Enum: `PrivatedBySomeoneElse`, `InDisallowedSector`, `InDisallowedChannel`, `AssignedToAnotherGroup`


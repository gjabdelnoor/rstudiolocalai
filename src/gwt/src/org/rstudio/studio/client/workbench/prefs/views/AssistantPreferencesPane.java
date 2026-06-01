/*
 * AssistantPreferencesPane.java
 *
 * Copyright (C) 2023 by Posit Software, PBC
 *
 * Unless you have received this program directly from Posit Software pursuant
 * to the terms of a commercial license agreement with Posit Software, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */
package org.rstudio.studio.client.workbench.prefs.views;

import java.util.ArrayList;
import java.util.List;

import org.rstudio.core.client.Debug;
import org.rstudio.core.client.DialogOptions;
import org.rstudio.core.client.JSON;
import org.rstudio.core.client.SingleShotTimer;
import org.rstudio.core.client.StringUtil;
import org.rstudio.core.client.command.AppCommand;
import org.rstudio.core.client.prefs.PreferencesDialogBaseResources;
import org.rstudio.core.client.prefs.RestartRequirement;
import org.rstudio.core.client.resources.ImageResource2x;
import org.rstudio.core.client.widget.DialogBuilder;
import org.rstudio.core.client.widget.LayoutGrid;
import org.rstudio.core.client.widget.NumericValueWidget;
import org.rstudio.core.client.widget.Operation;
import org.rstudio.core.client.widget.ProgressIndicator;
import org.rstudio.core.client.widget.SelectWidget;
import org.rstudio.core.client.widget.SmallButton;
import org.rstudio.core.client.widget.Spinner;
import org.rstudio.studio.client.application.AriaLiveService;
import org.rstudio.studio.client.application.events.EventBus;
import org.rstudio.studio.client.common.GlobalDisplay;
import org.rstudio.studio.client.common.HelpLink;
import org.rstudio.studio.client.common.dialog.WebDialogBuilderFactory;
import org.rstudio.studio.client.projects.model.ProjectsServerOperations;
import org.rstudio.studio.client.projects.model.RProjectOptions;
import org.rstudio.studio.client.projects.ui.prefs.events.ProjectOptionsChangedEvent;
import org.rstudio.studio.client.server.ServerError;
import org.rstudio.studio.client.server.ServerRequestCallback;
import org.rstudio.studio.client.workbench.assistant.Assistant;
import org.rstudio.studio.client.workbench.assistant.model.AssistantConstants;
import org.rstudio.studio.client.workbench.assistant.model.AssistantResponseTypes;
import org.rstudio.studio.client.workbench.assistant.model.AssistantResponseTypes.AssistantStatusResponse;
import org.rstudio.studio.client.workbench.assistant.model.AssistantRuntimeStatusChangedEvent;
import org.rstudio.studio.client.workbench.assistant.server.AssistantServerOperations;
import org.rstudio.studio.client.workbench.commands.Commands;
import org.rstudio.studio.client.workbench.model.Session;
import org.rstudio.studio.client.workbench.prefs.PrefsConstants;
import org.rstudio.studio.client.workbench.prefs.model.UserPrefs;
import org.rstudio.studio.client.workbench.prefs.model.UserPrefsAccessor;
import org.rstudio.core.client.widget.FormLabel;
import org.rstudio.studio.client.workbench.prefs.model.UserPrefsAccessorConstants;
import org.rstudio.studio.client.workbench.views.chat.PaiUtil;
import org.rstudio.studio.client.workbench.views.chat.PositAiInstallManager;
import org.rstudio.studio.client.workbench.views.chat.server.ChatServerOperations;

import com.google.gwt.aria.client.Roles;
import com.google.gwt.core.client.GWT;
import com.google.gwt.dom.client.Document;
import com.google.gwt.dom.client.Element;
import com.google.gwt.dom.client.Style.FontStyle;
import com.google.gwt.dom.client.Style.Unit;
import com.google.gwt.event.dom.client.ChangeEvent;
import com.google.gwt.event.dom.client.ChangeHandler;
import com.google.gwt.event.dom.client.ClickEvent;
import com.google.gwt.event.dom.client.ClickHandler;
import com.google.gwt.event.shared.HandlerRegistration;
import com.google.gwt.resources.client.ClientBundle;
import com.google.gwt.resources.client.CssResource;
import com.google.gwt.resources.client.ImageResource;
import com.google.gwt.user.client.Window;
import com.google.gwt.user.client.ui.CheckBox;
import com.google.gwt.user.client.ui.HTML;
import com.google.gwt.user.client.ui.HorizontalPanel;
import com.google.gwt.user.client.ui.Label;
import com.google.gwt.user.client.ui.PasswordTextBox;
import com.google.gwt.user.client.ui.SimplePanel;
import com.google.gwt.user.client.ui.TextBox;
import com.google.gwt.user.client.ui.VerticalPanel;
import com.google.gwt.user.client.ui.Widget;
import com.google.inject.Inject;


public class AssistantPreferencesPane extends PreferencesPane
{
   @Override
   public RestartRequirement onApply(UserPrefs prefs)
   {
      // Update preferences
      String selectedAssistant = selAssistant_.getValue();
      prefs.assistant().setGlobalValue(selectedAssistant);
      prefs.chatProvider().setGlobalValue(selChatProvider_.getValue());
      prefs.assistantTabKeyBehavior().setGlobalValue(selAssistantTabKeyBehavior_.getValue());
      prefs.assistantCompletionsTrigger().setGlobalValue(selAssistantCompletionsTrigger_.getValue());

      // Invert the collapse checkbox to get autoshow value
      prefs.assistantNesAutoshow().setGlobalValue(!cbAssistantNesCollapse_.getValue());

      // Also sync (deprecated) Copilot settings for now
      prefs.copilotEnabled().setGlobalValue(
            selectedAssistant.equals(UserPrefsAccessor.ASSISTANT_COPILOT));
      prefs.copilotTabKeyBehavior().setGlobalValue(selAssistantTabKeyBehavior_.getValue());
      prefs.copilotCompletionsTrigger().setGlobalValue(selAssistantCompletionsTrigger_.getValue());

      // Save custom provider settings
      prefs.aiProvider1Name().setGlobalValue(tbAiProvider1Name_.getText().trim());
      prefs.aiProvider1BaseUrl().setGlobalValue(tbAiProvider1BaseUrl_.getText().trim());
      prefs.aiProvider1ApiKey().setGlobalValue(tbAiProvider1ApiKey_.getText());
      prefs.aiProvider1Model().setGlobalValue(tbAiProvider1Model_.getText().trim());

      prefs.aiProvider2Name().setGlobalValue(tbAiProvider2Name_.getText().trim());
      prefs.aiProvider2BaseUrl().setGlobalValue(tbAiProvider2BaseUrl_.getText().trim());
      prefs.aiProvider2ApiKey().setGlobalValue(tbAiProvider2ApiKey_.getText());
      prefs.aiProvider2Model().setGlobalValue(tbAiProvider2Model_.getText().trim());

      prefs.aiProvider3Name().setGlobalValue(tbAiProvider3Name_.getText().trim());
      prefs.aiProvider3BaseUrl().setGlobalValue(tbAiProvider3BaseUrl_.getText().trim());
      prefs.aiProvider3ApiKey().setGlobalValue(tbAiProvider3ApiKey_.getText());
      prefs.aiProvider3Model().setGlobalValue(tbAiProvider3Model_.getText().trim());

      return super.onApply(prefs);
   }

   @Inject
   public AssistantPreferencesPane(EventBus events,
                                 Session session,
                                 UserPrefs prefs,
                                 Commands commands,
                                 AriaLiveService ariaLive,
                                 Assistant assistant,
                                 AssistantServerOperations server,
                                 ProjectsServerOperations projectServer,
                                 GlobalDisplay globalDisplay,
                                 PaiUtil paiUtil,
                                 ChatServerOperations chatServer)
   {
      events_ = events;
      session_ = session;
      prefs_ = prefs;
      commands_ = commands;
      assistant_ = assistant;
      server_ = server;
      projectServer_ = projectServer;
      globalDisplay_ = globalDisplay;
      paiUtil_ = paiUtil;
      chatServer_ = chatServer;
      installManager_ = new PositAiInstallManager();

      // Create assistant selector - conditionally include Posit AI option
      boolean paiEnabled = paiUtil_.isPositAssistantEnabled();
      String[] assistantLabels;
      String[] assistantValues;
      if (paiEnabled)
      {
         assistantLabels = new String[] {
               prefsConstants_.assistantEnum_none(),
               prefsConstants_.assistantEnum_posit(),
               prefsConstants_.assistantEnum_copilot()
         };
         assistantValues = new String[] {
               UserPrefsAccessor.ASSISTANT_NONE,
               UserPrefsAccessor.ASSISTANT_POSIT,
               UserPrefsAccessor.ASSISTANT_COPILOT
         };
      }
      else
      {
         assistantLabels = new String[] {
               prefsConstants_.assistantEnum_none(),
               prefsConstants_.assistantEnum_copilot()
         };
         assistantValues = new String[] {
               UserPrefsAccessor.ASSISTANT_NONE,
               UserPrefsAccessor.ASSISTANT_COPILOT
         };
      }
      selAssistant_ = new SelectWidget(
            constants_.assistantSelectLabel(),
            assistantLabels,
            assistantValues,
            false,
            true,
            false);
      selAssistant_.setValue(prefs_.assistant().getGlobalValue());

      // Container for dynamic assistant-specific content
      assistantDetailsPanel_ = new SimplePanel();

      lblAssistantStatus_ = new Label();
      lblAssistantStatus_.addStyleName(RES.styles().assistantStatusLabel());

      imgRefreshSpinner_ = new Spinner();
      imgRefreshSpinner_.addStyleName(RES.styles().refreshSpinner());
      imgRefreshSpinner_.setVisible(false);

      statusButtons_ = new ArrayList<SmallButton>();
      
      btnShowError_ = new SmallButton(constants_.assistantShowErrorLabel());
      btnShowError_.addStyleName(RES.styles().button());
      statusButtons_.add(btnShowError_);

      btnSignIn_ = new SmallButton(constants_.assistantSignInLabel());
      btnSignIn_.addStyleName(RES.styles().button());
      statusButtons_.add(btnSignIn_);

      btnSignOut_ = new SmallButton(constants_.assistantSignOutLabel());
      btnSignOut_.addStyleName(RES.styles().button());
      statusButtons_.add(btnSignOut_);

      btnActivate_ = new SmallButton(constants_.copilotActivateLabel());
      Roles.getLinkRole().set(btnActivate_.getElement());
      btnActivate_.getElement().setPropertyString("href", "https://github.com/settings/copilot");
      btnActivate_.addStyleName(RES.styles().button());
      statusButtons_.add(btnActivate_);

      btnInstall_ = new SmallButton(constants_.positAssistantInstallButton());
      btnInstall_.addStyleName(RES.styles().button());
      statusButtons_.add(btnInstall_);

      btnRefresh_ = new SmallButton(constants_.assistantRefreshLabel());
      btnRefresh_.addStyleName(RES.styles().button());
      statusButtons_.add(btnRefresh_);

      btnDiagnostics_ = new SmallButton(constants_.assistantDiagnosticsLabel());
      btnDiagnostics_.addStyleName(RES.styles().button());
      statusButtons_.add(btnDiagnostics_);

      btnProjectOptions_ = new SmallButton(constants_.assistantProjectOptionsLabel());
      btnProjectOptions_.addStyleName(RES.styles().button());
      statusButtons_.add(btnProjectOptions_);

      // Label for when project has overridden the assistant selection
      lblProjectOverride_ = new Label();
      lblProjectOverride_.getElement().getStyle().setFontStyle(FontStyle.ITALIC);

      cbAssistantShowMessages_ = checkboxPref(prefs_.assistantShowMessages(), true);
      cbAssistantToolbarButtonVisible_ = checkboxPref(prefs_.assistantToolbarButtonVisible(), true);
      selAssistantTabKeyBehavior_ = new SelectWidget(
            prefsConstants_.assistantTabKeyBehaviorTitle(),
            new String[] {
                  prefsConstants_.assistantTabKeyBehaviorEnum_suggestion(),
                  prefsConstants_.assistantTabKeyBehaviorEnum_completions()
            },
            new String[] {
                  UserPrefsAccessor.ASSISTANT_TAB_KEY_BEHAVIOR_SUGGESTION,
                  UserPrefsAccessor.ASSISTANT_TAB_KEY_BEHAVIOR_COMPLETIONS
            },
            false,
            true,
            false);

      selAssistantTabKeyBehavior_.setValue(prefs_.assistantTabKeyBehavior().getGlobalValue());

      selAssistantCompletionsTrigger_ = new SelectWidget(
            prefsConstants_.assistantCompletionsTriggerTitle(),
            new String[] {
                  prefsConstants_.assistantCompletionsTriggerEnum_auto(),
                  prefsConstants_.assistantCompletionsTriggerEnum_manual()
            },
            new String[] {
                  UserPrefsAccessor.ASSISTANT_COMPLETIONS_TRIGGER_AUTO,
                  UserPrefsAccessor.ASSISTANT_COMPLETIONS_TRIGGER_MANUAL
            },
            false,
            true,
            false);

      selAssistantCompletionsTrigger_.setValue(prefs_.assistantCompletionsTrigger().getGlobalValue());

      nvwAssistantCompletionsDelay_ = numericPref(
            constants_.assistantCompletionsDelayLabel(),
            10,
            5000,
            prefs_.assistantCompletionsDelay());

      cbAssistantNesEnabled_ = checkboxPref(prefs_.assistantNesEnabled(), true);
      cbAssistantNesCollapse_ = new CheckBox(constants_.assistantNesCollapseLabel());
      lessSpaced(cbAssistantNesCollapse_);
      cbAssistantNesCollapse_.setValue(!prefs_.assistantNesAutoshow().getGlobalValue());
      cbAssistantNesCollapse_.setTitle(constants_.assistantNesCollapseDescription());

      // Create chat provider selector - include Posit Assistant and 3 custom providers
      String[] chatProviderLabels;
      String[] chatProviderValues;
      if (paiEnabled)
      {
         chatProviderLabels = new String[] {
               prefsConstants_.chatProviderEnum_none(),
               prefsConstants_.chatProviderEnum_posit(),
               prefsConstants_.chatProviderEnum_custom_1(),
               prefsConstants_.chatProviderEnum_custom_2(),
               prefsConstants_.chatProviderEnum_custom_3()
         };
         chatProviderValues = new String[] {
               UserPrefsAccessor.CHAT_PROVIDER_NONE,
               UserPrefsAccessor.CHAT_PROVIDER_POSIT,
               UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_1,
               UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_2,
               UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_3
         };
      }
      else
      {
         chatProviderLabels = new String[] {
               prefsConstants_.chatProviderEnum_none(),
               prefsConstants_.chatProviderEnum_custom_1(),
               prefsConstants_.chatProviderEnum_custom_2(),
               prefsConstants_.chatProviderEnum_custom_3()
         };
         chatProviderValues = new String[] {
               UserPrefsAccessor.CHAT_PROVIDER_NONE,
               UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_1,
               UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_2,
               UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_3
         };
      }
      selChatProvider_ = new SelectWidget(
            constants_.assistantChatProviderLabel(),
            chatProviderLabels,
            chatProviderValues,
            false,
            true,
            false);
      selChatProvider_.setValue(prefs_.chatProvider().getGlobalValue());

      // Custom provider 1 configuration
      tbAiProvider1Name_ = new TextBox();
      tbAiProvider1Name_.setWidth("200px");
      tbAiProvider1Name_.setText(prefs_.aiProvider1Name().getGlobalValue());
      tbAiProvider1BaseUrl_ = new TextBox();
      tbAiProvider1BaseUrl_.setWidth("380px");
      tbAiProvider1BaseUrl_.setText(prefs_.aiProvider1BaseUrl().getGlobalValue());
      tbAiProvider1ApiKey_ = new PasswordTextBox();
      tbAiProvider1ApiKey_.setWidth("380px");
      tbAiProvider1ApiKey_.setText(prefs_.aiProvider1ApiKey().getGlobalValue());
      tbAiProvider1Model_ = new TextBox();
      tbAiProvider1Model_.setWidth("260px");
      tbAiProvider1Model_.setText(prefs_.aiProvider1Model().getGlobalValue());
      nvwAiProvider1ContextWindow_ = numericPref(
            prefs_.aiProvider1ContextWindow().getTitle(),
            1,
            1000000,
            prefs_.aiProvider1ContextWindow());

      // Custom provider 2 configuration
      tbAiProvider2Name_ = new TextBox();
      tbAiProvider2Name_.setWidth("200px");
      tbAiProvider2Name_.setText(prefs_.aiProvider2Name().getGlobalValue());
      tbAiProvider2BaseUrl_ = new TextBox();
      tbAiProvider2BaseUrl_.setWidth("380px");
      tbAiProvider2BaseUrl_.setText(prefs_.aiProvider2BaseUrl().getGlobalValue());
      tbAiProvider2ApiKey_ = new PasswordTextBox();
      tbAiProvider2ApiKey_.setWidth("380px");
      tbAiProvider2ApiKey_.setText(prefs_.aiProvider2ApiKey().getGlobalValue());
      tbAiProvider2Model_ = new TextBox();
      tbAiProvider2Model_.setWidth("260px");
      tbAiProvider2Model_.setText(prefs_.aiProvider2Model().getGlobalValue());
      nvwAiProvider2ContextWindow_ = numericPref(
            prefs_.aiProvider2ContextWindow().getTitle(),
            1,
            1000000,
            prefs_.aiProvider2ContextWindow());

      // Custom provider 3 configuration
      tbAiProvider3Name_ = new TextBox();
      tbAiProvider3Name_.setWidth("200px");
      tbAiProvider3Name_.setText(prefs_.aiProvider3Name().getGlobalValue());
      tbAiProvider3BaseUrl_ = new TextBox();
      tbAiProvider3BaseUrl_.setWidth("380px");
      tbAiProvider3BaseUrl_.setText(prefs_.aiProvider3BaseUrl().getGlobalValue());
      tbAiProvider3ApiKey_ = new PasswordTextBox();
      tbAiProvider3ApiKey_.setWidth("380px");
      tbAiProvider3ApiKey_.setText(prefs_.aiProvider3ApiKey().getGlobalValue());
      tbAiProvider3Model_ = new TextBox();
      tbAiProvider3Model_.setWidth("260px");
      tbAiProvider3Model_.setText(prefs_.aiProvider3Model().getGlobalValue());
      nvwAiProvider3ContextWindow_ = numericPref(
            prefs_.aiProvider3ContextWindow().getTitle(),
            1,
            1000000,
            prefs_.aiProvider3ContextWindow());

      linkCopilotTos_ = new HelpLink(
            constants_.copilotTermsOfServiceLinkLabel(),
            "github-copilot-terms-of-service",
            false);
      
      lblCopilotTos_ = new Label(constants_.copilotTermsOfServiceLabel());
      lblCopilotTos_.addStyleName(RES.styles().copilotTosLabel());

      assistantRuntimeStatusHandler_ = events_.addHandler(AssistantRuntimeStatusChangedEvent.TYPE, (event) ->
      {
         assistantStarted_ = event.getStatus() == AssistantRuntimeStatusChangedEvent.RUNNING;
      });

      projectOptionsChangedHandler_ = events_.addHandler(ProjectOptionsChangedEvent.TYPE, (event) ->
      {
         onProjectOptionsChanged(event.getData());
      });
   }

   @Override
   public void onUnload()
   {
      if (assistantRuntimeStatusHandler_ != null)
      {
         assistantRuntimeStatusHandler_.removeHandler();
         assistantRuntimeStatusHandler_ = null;
      }
      if (projectOptionsChangedHandler_ != null)
      {
         projectOptionsChangedHandler_.removeHandler();
         projectOptionsChangedHandler_ = null;
      }
      super.onUnload();
   }
   
   private void initDisplay()
   {
      // Chat section (displayed first)
      add(headerLabel(constants_.assistantChatTab()));
      add(selChatProvider_);

      // Custom provider configuration panels (shown/hidden based on selection)
      final VerticalPanel customProvider1Panel_ = createCustomProvider1Panel();
      final VerticalPanel customProvider2Panel_ = createCustomProvider2Panel();
      final VerticalPanel customProvider3Panel_ = createCustomProvider3Panel();
      add(customProvider1Panel_);
      add(customProvider2Panel_);
      add(customProvider3Panel_);

      // Show the correct panel based on initial selection
      String initialProvider = selChatProvider_.getValue();
      customProvider1Panel_.setVisible(initialProvider.equals(UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_1));
      customProvider2Panel_.setVisible(initialProvider.equals(UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_2));
      customProvider3Panel_.setVisible(initialProvider.equals(UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_3));

      // Add change handler for chat provider
      selChatProvider_.addChangeHandler((event) ->
      {
         String value = selChatProvider_.getValue();
         if (value.equals(UserPrefsAccessor.CHAT_PROVIDER_POSIT))
         {
            // Check for install/update/unsupported status
            checkPositAssistantInstallation(/* forAssistant= */ false);
         }
         customProvider1Panel_.setVisible(value.equals(UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_1));
         customProvider2Panel_.setVisible(value.equals(UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_2));
         customProvider3Panel_.setVisible(value.equals(UserPrefsAccessor.CHAT_PROVIDER_CUSTOM_3));
      });

      add(cbAssistantToolbarButtonVisible_);

      // Code suggestions section
      add(spacedBefore(headerLabel(constants_.assistantSuggestionsHeader())));

      // Add assistant selector
      add(selAssistant_);

      // Create project override panel (shown when project has a specific assistant configured)
      projectOverridePanel_ = new HorizontalPanel();
      projectOverridePanel_.setVerticalAlignment(HorizontalPanel.ALIGN_MIDDLE);
      projectOverridePanel_.add(lblProjectOverride_);
      SmallButton btnOpenProjectOptions = new SmallButton(constants_.assistantProjectOptionsLabel());
      btnOpenProjectOptions.addClickHandler((event) -> commands_.projectOptions().execute());
      btnOpenProjectOptions.getElement().getStyle().setMarginLeft(8, Unit.PX);
      projectOverridePanel_.add(btnOpenProjectOptions);
      projectOverridePanel_.setVisible(false);

      // Create the status panel (shared between Copilot and Posit AI)
      statusPanel_ = createStatusPanel();

      // Create the common settings panel (shared between Copilot and Posit AI)
      commonSettingsPanel_ = createCommonSettingsPanel();

      // Create Copilot-specific "Other" panel
      copilotOtherPanel_ = createCopilotOtherPanel();

      // Create Quick Reference panel (always displayed last)
      quickReferencePanel_ = createQuickReferencePanel();

      // Create the three panels
      nonePanel_ = createNonePanel();
      positAiPanel_ = createPositAiPanel();
      copilotPanel_ = createCopilotPanel();

      // Add container for dynamic content
      add(assistantDetailsPanel_);

      // Create Copilot Terms of Service panel at the bottom (absolute positioning)
      copilotTosPanel_ = new VerticalPanel();
      copilotTosPanel_.add(spaced(spacedBefore(lblCopilotTos_)));
      copilotTosPanel_.add(spaced(linkCopilotTos_));
      add(copilotTosPanel_);

      // Set up panel swapping based on assistant selection
      ChangeHandler assistantChangedHandler = new ChangeHandler()
      {
         @Override
         public void onChange(ChangeEvent event)
         {
            String value = selAssistant_.getValue();
            if (value.equals(UserPrefsAccessor.ASSISTANT_NONE))
            {
               // Insert project override panel at the top of nonePanel_ if there's a project override
               nonePanel_.insert(spaced(projectOverridePanel_), 0);
               assistantDetailsPanel_.setWidget(nonePanel_);
               copilotTosPanel_.setVisible(false);
               disableCopilot(UserPrefsAccessor.ASSISTANT_NONE);
               positAiRefreshed_ = false;
            }
            else if (value.equals(UserPrefsAccessor.ASSISTANT_POSIT))
            {
               // Move status panel, project override panel, and common settings panel to Posit AI panel
               positAiPanel_.insert(spaced(statusPanel_), 0);
               positAiPanel_.insert(spaced(projectOverridePanel_), 1);
               positAiPanel_.add(commonSettingsPanel_);
               positAiPanel_.add(quickReferencePanel_);
               assistantDetailsPanel_.setWidget(positAiPanel_);
               copilotTosPanel_.setVisible(false);
               disableCopilot(UserPrefsAccessor.ASSISTANT_POSIT);

               // Refresh Posit Assistant status when panel is shown
               if (!positAiRefreshed_)
               {
                  positAiRefreshed_ = true;

                  // Check if Posit Assistant is installed
                  server_.assistantVerifyInstalled(
                     UserPrefsAccessor.ASSISTANT_POSIT,
                     new ServerRequestCallback<Boolean>()
                     {
                        @Override
                        public void onResponseReceived(Boolean isInstalled)
                        {
                           if (event == null)
                           {
                              // Panel just loaded, not a user action — just refresh
                              refresh(UserPrefsAccessor.ASSISTANT_POSIT);
                           }
                           else
                           {
                              // User changed the selection — check for
                              // install, update, or unsupported status
                              checkPositAssistantInstallation(/* forAssistant= */ true);
                           }
                        }

                        @Override
                        public void onError(ServerError error)
                        {
                           Debug.logError(error);
                           lblAssistantStatus_.setText(constants_.assistantStartupError());
                        }
                     });
               }
            }
            else if (value.equals(UserPrefsAccessor.ASSISTANT_COPILOT))
            {
               // Move status panel, project override panel, common settings panel and Copilot-specific "Other" panel to Copilot panel
               if (session_.getSessionInfo().getCopilotEnabled())
               {
                  copilotPanel_.insert(spaced(statusPanel_), 0);
                  copilotPanel_.insert(spaced(projectOverridePanel_), 1);
               }
               else
               {
                  copilotPanel_.insert(spaced(projectOverridePanel_), 0);
               }
               copilotPanel_.add(commonSettingsPanel_);
               copilotPanel_.add(copilotOtherPanel_);
               copilotPanel_.add(quickReferencePanel_);
               assistantDetailsPanel_.setWidget(copilotPanel_);
               copilotTosPanel_.setVisible(true);
               positAiRefreshed_ = false;

               // Refresh Copilot status when panel is shown
               if (!copilotRefreshed_)
               {
                  copilotRefreshed_ = true;

                  // Check if Copilot is installed (passing assistantType so backend knows
                  // which language server to check, even if preference isn't saved yet)
                  server_.assistantVerifyInstalled(
                     UserPrefsAccessor.ASSISTANT_COPILOT,
                     new ServerRequestCallback<Boolean>()
                     {
                        @Override
                        public void onResponseReceived(Boolean isInstalled)
                        {
                           if (isInstalled)
                           {
                              // Copilot is installed - refresh status by passing assistantType
                              // so the backend can start the agent for the selected assistant
                              refresh(UserPrefsAccessor.ASSISTANT_COPILOT);
                           }
                           else
                           {
                              lblAssistantStatus_.setText(constants_.assistantAgentNotEnabled());
                           }
                        }

                        @Override
                        public void onError(ServerError error)
                        {
                           Debug.logError(error);
                           lblAssistantStatus_.setText(constants_.assistantStartupError());
                        }
                     });
               }
            }
         }
      };

      selAssistant_.addChangeHandler(assistantChangedHandler);
      assistantChangedHandler.onChange(null); // Initialize

      wrapWithPanel("assistant_prefs");
   }

   private VerticalPanel createNonePanel()
   {
      VerticalPanel panel = new VerticalPanel();
      Label lblInfo = new Label(constants_.assistantNoneInfo());
      panel.add(spaced(lblInfo));
      return panel;
   }

   private HorizontalPanel createStatusPanel()
   {
      HorizontalPanel panel = new HorizontalPanel();
      panel.setVerticalAlignment(HorizontalPanel.ALIGN_MIDDLE);
      panel.add(imgRefreshSpinner_);
      panel.setCellWidth(imgRefreshSpinner_, "24px");
      panel.add(lblAssistantStatus_);
      for (SmallButton button : statusButtons_)
         panel.add(button);
      return panel;
   }

   private VerticalPanel createPositAiPanel()
   {
      VerticalPanel panel = new VerticalPanel();
      // Status panel and common settings will be added dynamically
      return panel;
   }

   private VerticalPanel createCopilotPanel()
   {
      VerticalPanel panel = new VerticalPanel();

      if (!session_.getSessionInfo().getCopilotEnabled())
      {
         panel.add(new Label(constants_.copilotDisabledByAdmin()));
      }
      // Status panel, common settings and "Other" section will be added dynamically

      return panel;
   }

   private VerticalPanel createCopilotOtherPanel()
   {
      VerticalPanel panel = new VerticalPanel();
      panel.add(spacedBefore(headerLabel(constants_.otherCaption())));
      panel.add(cbAssistantShowMessages_);
      return panel;
   }

   private VerticalPanel createCustomProvider1Panel()
   {
      VerticalPanel panel = new VerticalPanel();
      panel.add(spacedBefore(headerLabel("Custom Provider 1")));
      panel.add(labeledInput(prefs_.aiProvider1Name().getTitle(), tbAiProvider1Name_));
      panel.add(labeledInput(prefs_.aiProvider1BaseUrl().getTitle(), tbAiProvider1BaseUrl_));
      panel.add(labeledInput(prefs_.aiProvider1ApiKey().getTitle(), tbAiProvider1ApiKey_));
      panel.add(labeledInput(prefs_.aiProvider1Model().getTitle(), tbAiProvider1Model_));
      panel.add(nvwAiProvider1ContextWindow_);
      return panel;
   }

   private VerticalPanel createCustomProvider2Panel()
   {
      VerticalPanel panel = new VerticalPanel();
      panel.add(spacedBefore(headerLabel("Custom Provider 2")));
      panel.add(labeledInput(prefs_.aiProvider2Name().getTitle(), tbAiProvider2Name_));
      panel.add(labeledInput(prefs_.aiProvider2BaseUrl().getTitle(), tbAiProvider2BaseUrl_));
      panel.add(labeledInput(prefs_.aiProvider2ApiKey().getTitle(), tbAiProvider2ApiKey_));
      panel.add(labeledInput(prefs_.aiProvider2Model().getTitle(), tbAiProvider2Model_));
      panel.add(nvwAiProvider2ContextWindow_);
      return panel;
   }

   private VerticalPanel createCustomProvider3Panel()
   {
      VerticalPanel panel = new VerticalPanel();
      panel.add(spacedBefore(headerLabel("Custom Provider 3")));
      panel.add(labeledInput(prefs_.aiProvider3Name().getTitle(), tbAiProvider3Name_));
      panel.add(labeledInput(prefs_.aiProvider3BaseUrl().getTitle(), tbAiProvider3BaseUrl_));
      panel.add(labeledInput(prefs_.aiProvider3ApiKey().getTitle(), tbAiProvider3ApiKey_));
      panel.add(labeledInput(prefs_.aiProvider3Model().getTitle(), tbAiProvider3Model_));
      panel.add(nvwAiProvider3ContextWindow_);
      return panel;
   }

   private VerticalPanel createCommonSettingsPanel()
   {
      VerticalPanel panel = new VerticalPanel();

      // Suggestions section
      panel.add(selAssistantCompletionsTrigger_);
      panel.add(cbAssistantNesEnabled_);
      panel.add(cbAssistantNesCollapse_);

      return panel;
   }

   private VerticalPanel createQuickReferencePanel()
   {
      VerticalPanel panel = new VerticalPanel();

      // Quick Reference section
      panel.add(spacedBefore(headerLabel(constants_.assistantQuickReferenceHeader())));

      LayoutGrid shortcutGrid = new LayoutGrid(2, 2);
      shortcutGrid.setCellPadding(4);
      shortcutGrid.setCellSpacing(0);

      String acceptShortcut = getStyledShortcut(commands_.assistantAcceptNextEditSuggestion());
      String dismissShortcut = getStyledShortcut(commands_.assistantDismissNextEditSuggestion());

      HTML acceptShortcutHtml = new HTML(acceptShortcut);
      acceptShortcutHtml.addStyleName(RES.styles().keyboardShortcut());
      HTML dismissShortcutHtml = new HTML(dismissShortcut);
      dismissShortcutHtml.addStyleName(RES.styles().keyboardShortcut());

      shortcutGrid.setWidget(0, 0, acceptShortcutHtml);
      shortcutGrid.setText(0, 1, constants_.assistantSuggestionsRequestAcceptHint());
      shortcutGrid.setWidget(1, 0, dismissShortcutHtml);
      shortcutGrid.setText(1, 1, constants_.assistantSuggestionsDismissHint());

      panel.add(shortcutGrid);

      return panel;
   }

   private String getStyledShortcut(AppCommand command)
   {
      String shortcut = command.getShortcutPrettyHtml();
      if (shortcut != null && shortcut.endsWith(";"))
      {
         shortcut = shortcut.substring(0, shortcut.length() - 1) +
                    "<span style=\"font-family:monospace;position:relative;top:-1px;\">;</span>";
      }
      return shortcut;
   }

   private void initModel()
   {
      selAssistantCompletionsTrigger_.addChangeHandler(new ChangeHandler()
      {
         @Override
         public void onChange(ChangeEvent event)
         {
            String value = selAssistantCompletionsTrigger_.getValue();
            if (value == UserPrefsAccessor.ASSISTANT_COMPLETIONS_TRIGGER_AUTO)
            {
               nvwAssistantCompletionsDelay_.setVisible(true);
            }
            else
            {
               nvwAssistantCompletionsDelay_.setVisible(false);
            }
         }
      });
      
      btnShowError_.addClickHandler(new ClickHandler()
      {
         @Override
         public void onClick(ClickEvent event)
         {
            // Prefer using a web dialog even on Desktop, as we want to allow customization
            // of how the UI is presented. In particular, we want to allow users to select
            // and copy text if they need to.
            DialogOptions options = new DialogOptions();
            options.width = "auto";
            options.height = "auto";
            options.userSelect = "text";
            
            WebDialogBuilderFactory builder = GWT.create(WebDialogBuilderFactory.class);
            DialogBuilder dialog = builder.create(
                  GlobalDisplay.MSG_INFO,
                  constants_.assistantStatusDialogCaption(),
                  assistantStartupError_,
                  options);
            
            dialog.showModal();
         }
      });
      
      btnSignIn_.addClickHandler(new ClickHandler()
      {
         @Override
         public void onClick(ClickEvent event)
         {
            String selectedType = selAssistant_.getValue();
            assistant_.signIn(selectedType, (response) -> refresh(selectedType));
         }
      });

      btnSignOut_.addClickHandler(new ClickHandler()
      {

         @Override
         public void onClick(ClickEvent event)
         {
            String selectedType = selAssistant_.getValue();
            assistant_.signOut(selectedType, (response) -> refresh(selectedType));
         }
      });
      
      btnActivate_.addClickHandler(new ClickHandler()
      {
         @Override
         public void onClick(ClickEvent event)
         {
            String href = btnActivate_.getElement().getPropertyString("href");
            Window.open(href, "_blank", "");
         }
      });
      
      btnRefresh_.addClickHandler(new ClickHandler()
      {
         @Override
         public void onClick(ClickEvent event)
         {
            refresh(selAssistant_.getValue());
         }
      });

      btnDiagnostics_.addClickHandler(new ClickHandler()
      {
         @Override
         public void onClick(ClickEvent event)
         {
            ProgressIndicator indicator = getProgressIndicator();
            indicator.onProgress(constants_.assistantDiagnosticReportProgressLabel());
            assistant_.showDiagnostics(selAssistant_.getValue(), () ->
            {
               indicator.onCompleted();
            });
         }
      });
      
      btnProjectOptions_.addClickHandler(new ClickHandler()
      {
         @Override
         public void onClick(ClickEvent event)
         {
            commands_.projectOptions().execute();
         }
      });

      btnInstall_.addClickHandler(new ClickHandler()
      {
         @Override
         public void onClick(ClickEvent event)
         {
            checkPositAssistantInstallation(/* forAssistant= */ true);
         }
      });
   }

   private void refresh(String assistantType)
   {
      imgRefreshSpinner_.setVisible(true);
      reset();

      // Use overloaded method to pass assistantType if provided
      ServerRequestCallback<AssistantStatusResponse> callback = new ServerRequestCallback<AssistantStatusResponse>()
      {
         @Override
         public void onResponseReceived(AssistantStatusResponse response)
         {
            imgRefreshSpinner_.setVisible(false);
            hideButtons();

            if (response == null)
            {
               lblAssistantStatus_.setText(constants_.assistantUnexpectedError());
            }
            else if (response.result == null)
            {
               if (response.error != null && response.error.getCode() == AssistantConstants.ErrorCodes.AGENT_NOT_INITIALIZED)
               {
                  // Assistant still starting up, so wait a second and refresh again
                  SingleShotTimer.fire(1000, () -> {
                     refresh(assistantType);
                  });
               }
               else if (response.error != null && response.error.getCode() != AssistantConstants.ErrorCodes.AGENT_SHUT_DOWN)
               {
                  lblAssistantStatus_.setText(constants_.assistantStartupError());
                  if (!StringUtil.isNullOrEmpty(response.output))
                  {
                     assistantStartupError_ = response.output;
                     showButtons(btnShowError_, btnRefresh_, btnDiagnostics_);
                  }
                  else
                  {
                     showButtons(btnRefresh_, btnDiagnostics_);
                  }
               }
               else if (AssistantResponseTypes.AssistantAgentNotRunningReason.isError(response.reason))
               {
                  int reason = (int) response.reason.valueOf();
                  lblAssistantStatus_.setText(AssistantResponseTypes.AssistantAgentNotRunningReason.reasonToString(reason, Assistant.getDisplayName(assistantType)));

                  // Show Install button for Posit Assistant when not installed
                  if (reason == AssistantResponseTypes.AssistantAgentNotRunningReason.NotInstalled &&
                      assistantType.equals(UserPrefsAccessor.ASSISTANT_POSIT))
                  {
                     showButtons(btnInstall_, btnRefresh_);
                  }
                  else
                  {
                     showButtons(btnRefresh_, btnDiagnostics_);
                  }
               }
               else if (projectOptions_ != null &&
                        UserPrefsAccessor.ASSISTANT_NONE.equals(projectOptions_.getAssistantOptions().assistant))
               {
                  lblAssistantStatus_.setText(constants_.assistantDisabledInProject(Assistant.getDisplayName(assistantType)));
                  showButtons(btnProjectOptions_);
               }
               else
               {
                  lblAssistantStatus_.setText(constants_.assistantAgentNotRunning());
                  showButtons(btnSignIn_, btnRefresh_, btnDiagnostics_);
               }
            }
            else if (response.result.status == AssistantConstants.STATUS_OK ||
                     response.result.status == AssistantConstants.STATUS_ALREADY_SIGNED_IN)
            {
               showButtons(btnSignOut_, btnRefresh_, btnDiagnostics_);
               lblAssistantStatus_.setText(constants_.assistantSignedInAsLabel(response.result.user));
            }
            else if (response.result.status == AssistantConstants.STATUS_NOT_AUTHORIZED)
            {
               showButtons(btnActivate_, btnSignOut_, btnRefresh_, btnDiagnostics_);
               lblAssistantStatus_.setText(constants_.copilotAccountNotActivated(response.result.user));
            }
            else if (response.result.status == AssistantConstants.STATUS_NOT_SIGNED_IN)
            {
               showButtons(btnSignIn_, btnRefresh_, btnDiagnostics_);
               lblAssistantStatus_.setText(constants_.assistantNotSignedIn());
            }
            else
            {
               String message = constants_.assistantUnknownResponse(JSON.stringify(response));
               lblAssistantStatus_.setText(message);
            }
         }

         @Override
         public void onError(ServerError error)
         {
            Debug.logError(error);
            hideButtons();
            lblAssistantStatus_.setText(constants_.assistantUnexpectedError());
            showButtons(btnRefresh_, btnDiagnostics_);
         }
      };

      // If no assistantType specified, use current preference
      String type = assistantType.isEmpty() ? prefs_.assistant().getGlobalValue() : assistantType;
      server_.assistantStatus(type, callback);
   }

   private void disableCopilot(String newAssistant)
   {
      // Eagerly disable Copilot so the agent stops immediately
      if (prefs_.copilotEnabled().getValue())
      {
         prefs_.copilotEnabled().setGlobalValue(false);
         prefs_.assistant().setGlobalValue(newAssistant);
         prefs_.writeUserPrefs((completed) -> {});
         copilotRefreshed_ = false;
      }
   }

   /**
    * Checks if Posit Assistant needs to be installed and prompts the user to install it.
    *
    * @param forAssistant True if this check is for the assistant (completions) preference,
    *                     false if it's for the chat provider preference.
    */
   private void checkPositAssistantInstallation(boolean forAssistant)
   {
      // Remember the previous value so we can revert if user declines
      final String previousAssistantValue = forAssistant ?
         prefs_.assistant().getGlobalValue() : null;
      final String previousChatProviderValue = !forAssistant ?
         prefs_.chatProvider().getGlobalValue() : null;

      installManager_.checkForUpdates(new PositAiInstallManager.UpdateCheckCallback()
      {
         @Override
         public void onNoUpdateAvailable()
         {
            // Posit Assistant is already installed and up-to-date
            if (forAssistant)
            {
               refresh(UserPrefsAccessor.ASSISTANT_POSIT);
            }
         }

         @Override
         public void onUpdateAvailable(String currentVersion, String newVersion,
                                       boolean isInitialInstall, boolean isDowngrade)
         {
            showInstallUpdatePrompt(newVersion, isInitialInstall, isDowngrade,
               forAssistant, previousAssistantValue, previousChatProviderValue);
         }

         @Override
         public void onIncompatibleVersion()
         {
            // No compatible version available - show error and revert
            globalDisplay_.showErrorMessage(
               constants_.positAssistantIncompatibleTitle(),
               constants_.positAssistantIncompatibleMessage(),
               (Operation) () -> {
                  revertPositAiPreference(forAssistant, previousAssistantValue, previousChatProviderValue);
               });
         }

         @Override
         public void onUnsupportedVersionUpgradeRequired(
             String currentVersion, String newVersion, boolean isDowngrade)
         {
            // Unsupported version with a required install. Can still be a downgrade
            // if the installed copy is unsupported (e.g. protocol mismatch) and the
            // recommended package is older than what's installed.
            showInstallUpdatePrompt(newVersion, false, isDowngrade, forAssistant,
               previousAssistantValue, previousChatProviderValue);
         }

         @Override
         public void onUnsupportedVersionNoUpdate(String currentVersion)
         {
            // Unsupported version with no update - show error and revert
            globalDisplay_.showErrorMessage(
               constants_.positAssistantUnsupportedVersionTitle(),
               constants_.positAssistantUnsupportedVersionMessage(),
               (Operation) () -> {
                  revertPositAiPreference(forAssistant, previousAssistantValue, previousChatProviderValue);
               });
         }

         @Override
         public void onUnsupportedProtocol()
         {
            // Protocol unsupported - RStudio itself needs updating
            globalDisplay_.showErrorMessage(
               constants_.positAssistantUnsupportedProtocolTitle(),
               constants_.positAssistantUnsupportedProtocolMessage(),
               (Operation) () -> {
                  revertPositAiPreference(forAssistant, previousAssistantValue, previousChatProviderValue);
               });
         }

         @Override
         public void onManifestUnavailable(String errorMessage)
         {
            // Manifest unavailable - can't verify compatibility
            globalDisplay_.showErrorMessage(
               constants_.positAssistantManifestUnavailableTitle(),
               constants_.positAssistantManifestUnavailableMessage(),
               (Operation) () -> {
                  revertPositAiPreference(forAssistant, previousAssistantValue, previousChatProviderValue);
               });
         }

         @Override
         public void onCheckFailed(String errorMessage)
         {
            // Check failed - this often happens when calling from Preferences pane
            // before the preference is saved. Since we know Posit Assistant isn't installed
            // (we got here because assistantVerifyInstalled returned false, or user
            // just selected Posit Assistant), offer to install without version info.
            showInstallUpdatePrompt(null, true, false, forAssistant,
               previousAssistantValue, previousChatProviderValue);
         }
      });
   }

   /**
    * Shows the install/update prompt dialog.
    */
   private void showInstallUpdatePrompt(String newVersion, boolean isInitialInstall,
                                        boolean isDowngrade,
                                        boolean forAssistant,
                                        String previousAssistantValue,
                                        String previousChatProviderValue)
   {
      String title;
      String message;
      String yesLabel;
      if (isInitialInstall)
      {
         title = constants_.positAssistantInstallTitle();
         message = (newVersion != null) ?
            constants_.positAssistantInstallMessage(newVersion) :
            constants_.positAssistantInstallMessageNoVersion();
         yesLabel = constants_.positAssistantInstallButton();
      }
      else if (isDowngrade)
      {
         title = constants_.positAssistantDowngradeTitle();
         message = constants_.positAssistantDowngradeMessage(newVersion);
         yesLabel = constants_.positAssistantInstallVersionButton(newVersion);
      }
      else
      {
         title = constants_.positAssistantUpdateTitle();
         message = constants_.positAssistantUpdateMessage(newVersion);
         yesLabel = constants_.positAssistantUpdateButton();
      }

      globalDisplay_.showYesNoMessage(
         GlobalDisplay.MSG_QUESTION,
         title,
         message,
         false,  // includeCancel
         (Operation) () -> {
            // User chose to install/update
            performPositAssistantInstall(forAssistant, previousAssistantValue, previousChatProviderValue);
         },
         (Operation) () -> {
            // User declined - revert the preference
            revertPositAiPreference(forAssistant, previousAssistantValue, previousChatProviderValue);
         },
         null,  // cancelOperation - not used since includeCancel is false
         yesLabel,
         constants_.positAssistantCancelButton(),
         true);  // yesIsDefault
   }

   /**
    * Performs the Posit Assistant installation with progress dialog.
    */
   private void performPositAssistantInstall(boolean forAssistant,
                                      String previousAssistantValue,
                                      String previousChatProviderValue)
   {
      // Save the appropriate preference first - the server requires either
      // chatProvider or assistant to be set to "posit" before it will allow installation
      if (forAssistant)
      {
         prefs_.assistant().setGlobalValue(UserPrefsAccessor.ASSISTANT_POSIT);
      }
      else
      {
         prefs_.chatProvider().setGlobalValue(UserPrefsAccessor.CHAT_PROVIDER_POSIT);
      }

      // Write prefs and then start installation
      prefs_.writeUserPrefs((completed) -> {
         doInstall(forAssistant, previousAssistantValue, previousChatProviderValue);
      });
   }

   /**
    * Actually performs the installation after preferences are saved.
    */
   private void doInstall(boolean forAssistant,
                          String previousAssistantValue,
                          String previousChatProviderValue)
   {
      final com.google.gwt.user.client.Command dismissProgress =
         globalDisplay_.showProgress(constants_.positAssistantInstallingMessage());

      installManager_.installUpdate(new PositAiInstallManager.InstallCallback()
      {
         @Override
         public void onInstallStarted()
         {
            // Progress dialog is already showing
         }

         @Override
         public void onInstallProgress(String status)
         {
            // Progress dialog shows a generic message; no additional status updates
         }

         @Override
         public void onInstallComplete()
         {
            dismissProgress.execute();
            globalDisplay_.showMessage(
               GlobalDisplay.MSG_INFO,
               constants_.positAssistantInstallCompleteTitle(),
               constants_.positAssistantInstallCompleteMessage(),
               (Operation) () -> {
                  // Refresh the assistant status if this was for the completions pref
                  if (forAssistant)
                  {
                     positAiRefreshed_ = false;
                     refresh(UserPrefsAccessor.ASSISTANT_POSIT);
                  }
               });
         }

         @Override
         public void onInstallFailed(String errorMessage)
         {
            dismissProgress.execute();

            globalDisplay_.showErrorMessage(
               constants_.positAssistantInstallFailedTitle(),
               constants_.positAssistantInstallFailedMessage(errorMessage),
               (Operation) () -> {
                  // Revert the preference since installation failed
                  revertPositAiPreference(forAssistant, previousAssistantValue, previousChatProviderValue);
               });
         }
      });
   }

   /**
    * Reverts the Posit AI preference to its previous value.
    */
   private void revertPositAiPreference(boolean forAssistant,
                                        String previousAssistantValue,
                                        String previousChatProviderValue)
   {
      if (forAssistant)
      {
         // Revert assistant preference to previous value
         String revertTo = previousAssistantValue != null
            ? previousAssistantValue
            : UserPrefsAccessor.ASSISTANT_NONE;

         if (revertTo.equals(selAssistant_.getValue()))
            return;

         selAssistant_.setValue(revertTo);
         prefs_.assistant().setGlobalValue(revertTo);
         positAiRefreshed_ = false;

         // Write the reverted preference
         prefs_.writeUserPrefs((completed) -> {});

         // Trigger the change handler to update the UI
         selAssistant_.getListBox().fireEvent(new ChangeEvent() {});
      }
      else
      {
         // Revert chat provider preference to previous value
         String revertTo = previousChatProviderValue != null
            ?  previousChatProviderValue
            : UserPrefsAccessor.CHAT_PROVIDER_NONE;
         
         if (revertTo.equals(selChatProvider_.getValue()))
            return;

         selChatProvider_.setValue(revertTo);
         prefs_.chatProvider().setGlobalValue(revertTo);

         // Write the reverted preference
         prefs_.writeUserPrefs((completed) -> {});
      }
   }

   private void reset()
   {
      assistantStartupError_ = null;
      hideButtons();
   }
   
   @Override
   public ImageResource getIcon()
   {
      if (useDarkDialogTheme())
         return new ImageResource2x(PreferencesDialogBaseResources.INSTANCE.iconAssistantDark2x());
      return new ImageResource2x(PreferencesDialogBaseResources.INSTANCE.iconAssistant2x());
   }

   @Override
   public String getName()
   {
      return constants_.assistantPaneName();
   }

   @Override
   protected void initialize(UserPrefs prefs)
   {
      // Migration: if rstudio_assistant is "none" but copilot_enabled is true, auto-migrate to "copilot"
      String assistant = prefs.assistant().getGlobalValue();
      if (assistant.equals(UserPrefsAccessor.ASSISTANT_NONE) &&
          prefs.copilotEnabled().getGlobalValue())
      {
         prefs.assistant().setGlobalValue(UserPrefsAccessor.ASSISTANT_COPILOT);
         selAssistant_.setValue(UserPrefsAccessor.ASSISTANT_COPILOT);
      }

      // Reset to "none" if user has Posit AI selected but Posit Assistant is no longer enabled
      if (assistant.equals(UserPrefsAccessor.ASSISTANT_POSIT) &&
          !paiUtil_.isPositAssistantEnabled())
      {
         prefs.assistant().setGlobalValue(UserPrefsAccessor.ASSISTANT_NONE);
         selAssistant_.setValue(UserPrefsAccessor.ASSISTANT_NONE);
      }

      projectServer_.readProjectOptions(new ServerRequestCallback<RProjectOptions>()
      {
         @Override
         public void onResponseReceived(RProjectOptions options)
         {
            projectOptions_ = options;
            init();
         }

         @Override
         public void onError(ServerError error)
         {
            Debug.logError(error);
            init();
         }
      });
   }
   
   private void init()
   {
      initDisplay();
      initModel();

      // Check if project has a specific assistant configured (overrides global setting)
      String projectAssistant = getProjectAssistant();
      if (projectAssistant != null)
      {
         // Project has overridden the assistant selection
         projectAssistantOverride_ = projectAssistant;

         // Use appropriate message for disabled vs configured
         if (projectAssistant.equals(UserPrefsAccessor.ASSISTANT_NONE))
            lblProjectOverride_.setText(constants_.codeAssistantDisabledInProject());
         else
            lblProjectOverride_.setText(constants_.assistantConfiguredInProject(
               Assistant.getDisplayName(projectAssistant)));

         projectOverridePanel_.setVisible(true);

         // Disable the selector and set it to match project's assistant
         selAssistant_.setEnabled(false);
         selAssistant_.setValue(projectAssistant);

         // Trigger the change handler to update the displayed panel
         selAssistant_.getListBox().fireEvent(new ChangeEvent() {});
      }
   }

   /**
    * Returns the project-specific assistant if one is configured, or null if
    * the project uses the default (global) setting.
    */
   private String getProjectAssistant()
   {
      if (projectOptions_ == null)
         return null;

      String projectAssistant = projectOptions_.getAssistantOptions().assistant;

      // "default", null, or empty means use global setting
      if (projectAssistant == null ||
          projectAssistant.isEmpty() ||
          projectAssistant.equals("default"))
      {
         return null;
      }

      return projectAssistant;
   }

   /**
    * Called when project options are changed (e.g., from the Project Options dialog).
    * Updates the UI to reflect any changes to the project's assistant setting.
    */
   private void onProjectOptionsChanged(RProjectOptions options)
   {
      // Update our cached project options
      projectOptions_ = options;

      // Re-check if there's a project override
      String projectAssistant = getProjectAssistant();

      if (projectAssistant != null)
      {
         // Project has a specific assistant configured
         projectAssistantOverride_ = projectAssistant;

         // Use appropriate message for disabled vs configured
         if (projectAssistant.equals(UserPrefsAccessor.ASSISTANT_NONE))
            lblProjectOverride_.setText(constants_.codeAssistantDisabledInProject());
         else
            lblProjectOverride_.setText(constants_.assistantConfiguredInProject(
               Assistant.getDisplayName(projectAssistant)));

         projectOverridePanel_.setVisible(true);
         selAssistant_.setEnabled(false);
         selAssistant_.setValue(projectAssistant);

         // Reset refresh flags so status gets refreshed for the new assistant
         copilotRefreshed_ = false;
         positAiRefreshed_ = false;

         // Trigger the change handler to update the displayed panel
         selAssistant_.getListBox().fireEvent(new ChangeEvent() {});
      }
      else
      {
         // Project is using global default
         projectAssistantOverride_ = null;
         projectOverridePanel_.setVisible(false);
         selAssistant_.setEnabled(true);

         // Restore selector to global preference value
         selAssistant_.setValue(prefs_.assistant().getGlobalValue());

         // Reset refresh flags
         copilotRefreshed_ = false;
         positAiRefreshed_ = false;

         // Trigger the change handler to update the displayed panel
         selAssistant_.getListBox().fireEvent(new ChangeEvent() {});
      }
   }

   private void hideButtons()
   {
      for (SmallButton button : statusButtons_)
      {
         button.setEnabled(false);
         button.setVisible(false);
      }
   }
   
   private void showButtons(SmallButton... buttons)
   {
      for (SmallButton button : buttons)
      {
         button.setEnabled(true);
         button.setVisible(true);
      }
   }
   
   public interface Styles extends CssResource
   {
      String button();
      String assistantStatusLabel();
      String copilotTosLabel();
      String refreshSpinner();
      String keyboardShortcut();
   }

   public interface Resources extends ClientBundle
   {
      @Source("AssistantPreferencesPane.css")
      Styles styles();
   }

   public static Resources RES = GWT.create(Resources.class);
   static
   {
      RES.styles().ensureInjected();
   }
   
   // State
   private String assistantStartupError_;
   private HandlerRegistration assistantRuntimeStatusHandler_;
   private HandlerRegistration projectOptionsChangedHandler_;
   private boolean assistantStarted_ = false; // did Copilot get started while the dialog was open?
   private boolean copilotRefreshed_ = false; // has Copilot status been refreshed for this pane instance?
   private boolean positAiRefreshed_ = false; // has Posit Assistant status been refreshed for this pane instance?
   private RProjectOptions projectOptions_;
   private String projectAssistantOverride_; // non-null when project has overridden assistant

   // Assistant panels (created in initDisplay)
   private VerticalPanel nonePanel_;
   private VerticalPanel positAiPanel_;
   private VerticalPanel copilotPanel_;
   private VerticalPanel copilotTosPanel_;
   private VerticalPanel commonSettingsPanel_;
   private VerticalPanel copilotOtherPanel_;
   private VerticalPanel quickReferencePanel_;
   private HorizontalPanel statusPanel_;
   private HorizontalPanel projectOverridePanel_;

   // UI
   private final SelectWidget selAssistant_;
   private final SimplePanel assistantDetailsPanel_;
   private final Label lblAssistantStatus_;
   private final Spinner imgRefreshSpinner_;
   private final CheckBox cbAssistantShowMessages_;
   private final CheckBox cbAssistantToolbarButtonVisible_;
   private final CheckBox cbAssistantNesEnabled_;
   private final CheckBox cbAssistantNesCollapse_;
   private final List<SmallButton> statusButtons_;
   private final SmallButton btnShowError_;
   private final SmallButton btnSignIn_;
   private final SmallButton btnSignOut_;
   private final SmallButton btnActivate_;
   private final SmallButton btnRefresh_;
   private final SmallButton btnDiagnostics_;
   private final SmallButton btnProjectOptions_;
   private final SmallButton btnInstall_;
   private final NumericValueWidget nvwAssistantCompletionsDelay_;
   private final SelectWidget selAssistantTabKeyBehavior_;
   private final SelectWidget selAssistantCompletionsTrigger_;
   private final SelectWidget selChatProvider_;

   // Custom provider 1 UI
   private final TextBox tbAiProvider1Name_;
   private final TextBox tbAiProvider1BaseUrl_;
   private final PasswordTextBox tbAiProvider1ApiKey_;
   private final TextBox tbAiProvider1Model_;
   private final NumericValueWidget nvwAiProvider1ContextWindow_;

   // Custom provider 2 UI
   private final TextBox tbAiProvider2Name_;
   private final TextBox tbAiProvider2BaseUrl_;
   private final PasswordTextBox tbAiProvider2ApiKey_;
   private final TextBox tbAiProvider2Model_;
   private final NumericValueWidget nvwAiProvider2ContextWindow_;

   // Custom provider 3 UI
   private final TextBox tbAiProvider3Name_;
   private final TextBox tbAiProvider3BaseUrl_;
   private final PasswordTextBox tbAiProvider3ApiKey_;
   private final TextBox tbAiProvider3Model_;
   private final NumericValueWidget nvwAiProvider3ContextWindow_;

   private final HelpLink linkCopilotTos_;
   private final Label lblCopilotTos_;
   private final Label lblProjectOverride_;

   // Injected
   private final EventBus events_;
   private final Session session_;
   private final UserPrefs prefs_;
   private final Commands commands_;
   private final Assistant assistant_;
   private final AssistantServerOperations server_;
   private final ProjectsServerOperations projectServer_;
   private final GlobalDisplay globalDisplay_;
   private final PaiUtil paiUtil_;
   private final ChatServerOperations chatServer_;
   private final PositAiInstallManager installManager_;
   
   private HorizontalPanel labeledInput(String label, Widget widget)
   {
      HorizontalPanel panel = new HorizontalPanel();
      panel.setVerticalAlignment(HorizontalPanel.ALIGN_MIDDLE);
      FormLabel formLabel = new FormLabel(label, widget);
      formLabel.setWidth("180px");
      panel.add(formLabel);
      panel.add(widget);
      return panel;
   }

   private boolean useDarkDialogTheme()
   {
      Element container = Document.get().getElementById("rstudio_container");
      return prefs_.useDarkThemeModalDialogs().getValue() &&
             container != null &&
             container.hasClassName("rstudio-themes-dark");
   }

   private static final UserPrefsAccessorConstants prefsConstants_ = GWT.create(UserPrefsAccessorConstants.class);
   private static final PrefsConstants constants_ = GWT.create(PrefsConstants.class);

}

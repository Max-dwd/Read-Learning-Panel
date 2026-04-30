const getSidePanelPath = () => chrome.runtime.getManifest().side_panel?.default_path ?? "sidepanel.html";

async function configureDefaultSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {
    // Older Chrome builds may not support this behavior setter yet.
  });
  await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {
    // Keep the tab-specific open path working even if global disabling is unavailable.
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void configureDefaultSidePanel();
});

chrome.runtime.onStartup?.addListener(() => {
  void configureDefaultSidePanel();
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) {
    return;
  }

  const tabId = tab.id;
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: getSidePanelPath(),
    enabled: true
  }, () => {
    void chrome.sidePanel.open({ tabId });
  });
});

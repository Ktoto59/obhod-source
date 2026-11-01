include $(TOPDIR)/rules.mk

PKG_NAME:=obhod
PKG_VERSION:=0.1.13
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

define Package/obhod
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Obhod selective routing service
  DEPENDS:=+firewall4 +kmod-tun +kmod-nft-tproxy +kmod-nft-queue +uclient-fetch +ca-bundle +jshn +jsonfilter +rpcd +rpcd-mod-file +ucode +ucode-mod-fs
endef

define Package/obhod/conffiles
/etc/config/obhod
endef

define Build/Compile
endef

define Package/obhod/install
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d $(1)/etc/obhod
	chmod 700 $(1)/etc/obhod
	$(INSTALL_CONF) ./files/etc/config/obhod $(1)/etc/config/obhod
	$(INSTALL_BIN) ./files/etc/init.d/obhod $(1)/etc/init.d/obhod
	$(INSTALL_DIR) $(1)/usr/libexec/obhod $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./files/usr/libexec/obhod/* $(1)/usr/libexec/obhod/
	$(INSTALL_BIN) ./files/usr/libexec/rpcd/obhod $(1)/usr/libexec/rpcd/obhod
	$(INSTALL_DIR) $(1)/usr/share/obhod
	$(INSTALL_DATA) ./files/usr/share/obhod/version $(1)/usr/share/obhod/version
endef

define Package/obhod/postinst
#!/bin/sh
	[ -n "$$IPKG_INSTROOT" ] || { /etc/init.d/obhod enable; [ -d /var/lock/obhod-update.lock ] || /etc/init.d/rpcd reload; }
exit 0
endef

define Package/obhod/prerm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] || /etc/init.d/obhod stop
exit 0
endef

$(eval $(call BuildPackage,obhod))

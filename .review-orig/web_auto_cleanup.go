package web

import (
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 自动清理对标 DeepSeek 磁盘缓存的闲置回收：对话即缓存条目，
// 命中（会话复用）自动刷新存活时间，长期闲置或超出数量上限的条目
// 由后台循环回收，防止滥用/测试把云端对话堆满触发封号。

func (s *Server) StartAutoCleanup() {
	if strings.EqualFold(os.Getenv("M365_AUTO_CLEANUP"), "0") ||
		strings.EqualFold(os.Getenv("M365_AUTO_CLEANUP"), "false") ||
		strings.EqualFold(os.Getenv("M365_AUTO_CLEANUP"), "no") ||
		strings.EqualFold(os.Getenv("M365_AUTO_CLEANUP"), "off") {
		log.Printf("[auto-cleanup] disabled via M365_AUTO_CLEANUP")
		return
	}

	interval := 30 * time.Minute
	if v := os.Getenv("M365_AUTO_CLEANUP_INTERVAL_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			interval = time.Duration(n) * time.Minute
		}
	}
	// 闲置 2 小时即为过期（与 sessionResolver 的默认会话 TTL 一致）：
	// 云端对话生命周期 = 内容缓存条目生命周期，长时间无命中就回收。
	maxAge := 2 * time.Hour
	if v := os.Getenv("M365_AUTO_CLEANUP_MAX_AGE_HOURS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxAge = time.Duration(n) * time.Hour
		}
	}
	// 云端最多保留 5 个对话，超过就删最旧的（用户要求对话总数不超过 5）
	keepN := 5
	if v := os.Getenv("M365_AUTO_CLEANUP_KEEP_N"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			keepN = n
		}
	}

	log.Printf("[auto-cleanup] enabled interval=%s max_age=%s keep_n=%d", interval, maxAge, keepN)
	go func() {
		for {
			time.Sleep(interval)
			s.autoCleanupOnce(maxAge, keepN)
		}
	}()
}

func (s *Server) autoCleanupOnce(maxAge time.Duration, keepN int) {
	if m365CloudClient == nil {
		return
	}
	now := time.Now()
	active := s.activeConversationSet(maxAge)

	type cand struct {
		id       string
		createMs int64
	}
	deleted := 0
	for round := 0; round < 100; round++ {
		chats, err := m365CloudClient.ListConversations()
		if err != nil {
			log.Printf("[auto-cleanup] list failed: %v", err)
			return
		}
		if len(chats) == 0 {
			break
		}

		nowMs := now.UnixMilli()
		var stale, rest []cand
		for _, chat := range chats {
			convID, _ := chat["conversationId"].(string)
			if convID == "" {
				continue
			}
			if active[convID] {
				continue
			}
			createMs, ok := chat["createTimeUtc"].(float64)
			if !ok {
				// 时间戳缺失或类型不符时不视为旧会话，避免误删刚创建的云端对话。
				continue
			}
			createInt := int64(createMs)
			if nowMs-createInt > maxAge.Milliseconds() {
				stale = append(stale, cand{convID, createInt})
			} else {
				rest = append(rest, cand{convID, createInt})
			}
		}

		anyDeleted := false
		for _, c := range stale {
			if err := m365CloudClient.DeleteConversation(c.id); err != nil {
				log.Printf("[auto-cleanup] delete %s failed: %v", c.id, err)
				continue
			}
			s.dropConversation(c.id)
			deleted++
			anyDeleted = true
		}
		sort.Slice(rest, func(i, j int) bool { return rest[i].createMs < rest[j].createMs })
		for i := keepN; i < len(rest); i++ {
			c := rest[i]
			if err := m365CloudClient.DeleteConversation(c.id); err != nil {
				log.Printf("[auto-cleanup] delete %s failed: %v", c.id, err)
				continue
			}
			s.dropConversation(c.id)
			deleted++
			anyDeleted = true
		}
		if !anyDeleted {
			break
		}
	}
	if deleted > 0 {
		log.Printf("[auto-cleanup] removed %d idle conversations", deleted)
	}
}

// activeConversationSet 收集受保护的对话：白名单、仍在会话窗口内的
// 防串号绑定、最近用过的用户会话。它们对应"缓存命中"的条目，永不回收。
func (s *Server) activeConversationSet(window time.Duration) map[string]bool {
	active := map[string]bool{}
	cutoff := time.Now().UTC().Add(-window)

	for _, sess := range s.sessionResolver.ListSessions() {
		if sess.LastUsedAt.After(cutoff) {
			active[sess.ConversationID] = true
		}
	}
	for convID := range s.userSessions.ActiveConversations(window) {
		active[convID] = true
	}
	for _, id := range s.conversationManager.WhitelistedIDs() {
		active[id] = true
	}
	for _, c := range s.conversationManager.List() {
		if c.LastUsedAt.After(cutoff) {
			active[c.ID] = true
		}
	}
	return active
}

// dropConversation 删除云端对话后联动清理本地索引与防串号绑定，
// 防止后续请求复用已死的对话造成串号或幽灵会话。
func (s *Server) dropConversation(convID string) {
	s.conversationManager.Delete(convID)
	s.sessionResolver.UnbindByConversation(convID)
}

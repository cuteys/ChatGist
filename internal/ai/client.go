package ai

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/cuteys/ChatGist/internal/config"
	"github.com/cuteys/ChatGist/internal/storage"
	"github.com/cuteys/ChatGist/internal/telegram"
	openai "github.com/sashabaranov/go-openai"
)

type Client struct {
	cfg    *config.Config
	client *openai.Client
}

func New(cfg *config.Config) *Client {
	openaiCfg := openai.DefaultConfig(cfg.AIAPIKey)
	if cfg.AIBaseURL != "" {
		openaiCfg.BaseURL = strings.TrimRight(cfg.AIBaseURL, "/")
	}
	openaiCfg.HTTPClient = &http.Client{
		Timeout: 300 * time.Second, // 留足大模型长上下文与思考耗时
	}

	return &Client{
		cfg:    cfg,
		client: openai.NewClientWithConfig(openaiCfg),
	}
}

func (c *Client) getReasoningLadder() []string {
	effort := strings.ToLower(strings.TrimSpace(c.cfg.ReasoningEffort))
	switch effort {
	case "high":
		return []string{"high", "medium", "low", "none"}
	case "medium":
		return []string{"medium", "low", "none"}
	case "low":
		return []string{"low", "none"}
	default:
		return []string{"none"}
	}
}

func formatMessageTime(ts int64, defaultStr string) string {
	if ts <= 0 {
		return defaultStr
	}
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}
	t := time.UnixMilli(ts).In(loc)
	return t.Format("2006-01-02 15:04:05")
}

type ChatDiagnostics struct {
	MessageCount   int
	ImageCount     int
	TextCharCount  int
	EstimatedBytes int
}

func (d ChatDiagnostics) Format() string {
	kb := float64(d.EstimatedBytes) / 1024.0
	if kb >= 1024.0 {
		return fmt.Sprintf("消息 %d 条 | 图片 %d 张 | 文本 %d 字 | 约 %.2f MB", d.MessageCount, d.ImageCount, d.TextCharCount, kb/1024.0)
	}
	return fmt.Sprintf("消息 %d 条 | 图片 %d 张 | 文本 %d 字 | 约 %.1f KB", d.MessageCount, d.ImageCount, d.TextCharCount, kb)
}

var supportedImagePrefixes = []string{
	"data:image/jpeg;base64,",
	"data:image/png;base64,",
	"data:image/webp;base64,",
}

func isValidStandardBase64(s string) bool {
	if len(s) == 0 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '=' {
			continue
		}
		return false
	}
	return true
}

// extractEmbeddedImage 仅提取合法位图 Base64 并按空白字符截断，避免将网页 SVG 或尾部文本误作图片发送导致上游解码 400
func extractEmbeddedImage(content string) (textBefore, imgDataURL, textAfter string, ok bool) {
	imgIdx := -1
	matchedPrefix := ""
	for _, prefix := range supportedImagePrefixes {
		if idx := strings.Index(content, prefix); idx != -1 && (imgIdx == -1 || idx < imgIdx) {
			imgIdx = idx
			matchedPrefix = prefix
		}
	}
	if imgIdx == -1 {
		return content, "", "", false
	}

	rest := content[imgIdx:]
	endIdx := strings.IndexAny(rest, " 	\r\n")
	var candidate string
	var after string
	if endIdx == -1 {
		candidate = rest
	} else {
		candidate = rest[:endIdx]
		after = strings.TrimSpace(rest[endIdx:])
	}

	b64Payload := candidate[len(matchedPrefix):]
	if !isValidStandardBase64(b64Payload) {
		return content, "", "", false
	}

	return strings.TrimSpace(content[:imgIdx]), candidate, after, true
}

func CalcDiagnostics(messages []*storage.Message) ChatDiagnostics {
	diag := ChatDiagnostics{MessageCount: len(messages)}
	for _, m := range messages {
		diag.TextCharCount += len([]rune(m.UserName))
		if before, _, after, ok := extractEmbeddedImage(m.Content); ok {
			diag.ImageCount++
			diag.TextCharCount += len([]rune(before)) + len([]rune(after))
		} else {
			diag.TextCharCount += len([]rune(m.Content))
		}
		diag.EstimatedBytes += len(m.UserName) + len(m.Content) + 64
	}
	return diag
}

// CompactChatMessageParts 将相邻纯文本节点合并为单个文本节点以精简多模态数组开销
func CompactChatMessageParts(parts []openai.ChatMessagePart) []openai.ChatMessagePart {
	var compacted []openai.ChatMessagePart
	var textBuf []string
	flushText := func() {
		if len(textBuf) > 0 {
			compacted = append(compacted, openai.ChatMessagePart{
				Type: openai.ChatMessagePartTypeText,
				Text: strings.Join(textBuf, "\n"),
			})
			textBuf = nil
		}
	}
	for _, p := range parts {
		if p.Type == openai.ChatMessagePartTypeText {
			textBuf = append(textBuf, p.Text)
		} else {
			flushText()
			compacted = append(compacted, p)
		}
	}
	flushText()
	return compacted
}

func (c *Client) BuildChatHistoryParts(messages []*storage.Message) []openai.ChatMessagePart {
	var parts []openai.ChatMessagePart

	for _, m := range messages {
		tStr := formatMessageTime(m.TimeStamp, m.MessageTime)
		sender := fmt.Sprintf("%s [%s]:", m.UserName, tStr)
		link := telegram.GetMessageLink(m.GroupID, m.MessageID)

		parts = append(parts, openai.ChatMessagePart{
			Type: openai.ChatMessagePartTypeText,
			Text: "====================\n" + sender,
		})

		if textBefore, imgPart, textAfter, ok := extractEmbeddedImage(m.Content); ok {
			// 分离文字说明与 Base64 图片，防止带配文或回复的消息将 Base64 作为纯文本泄露至上下文
			if textBefore != "" {
				parts = append(parts, openai.ChatMessagePart{
					Type: openai.ChatMessagePartTypeText,
					Text: textBefore,
				})
			}

			parts = append(parts, openai.ChatMessagePart{
				Type: openai.ChatMessagePartTypeImageURL,
				ImageURL: &openai.ChatMessageImageURL{
					URL:    imgPart,
					Detail: openai.ImageURLDetailAuto,
				},
			})

			if textAfter != "" {
				parts = append(parts, openai.ChatMessagePart{
					Type: openai.ChatMessagePartTypeText,
					Text: textAfter,
				})
			}
		} else {
			parts = append(parts, openai.ChatMessagePart{
				Type: openai.ChatMessagePartTypeText,
				Text: m.Content,
			})
		}

		parts = append(parts, openai.ChatMessagePart{
			Type: openai.ChatMessagePartTypeText,
			Text: link + "\n====================",
		})
	}

	return CompactChatMessageParts(parts)
}

func (c *Client) CallChatModelWithReasoningRetry(ctx context.Context, systemPrompt string, historyParts []openai.ChatMessagePart, userQuestion string) (string, error) {
	ladder := c.getReasoningLadder()
	var lastErr error

	userMsg := openai.ChatCompletionMessage{
		Role:         openai.ChatMessageRoleUser,
		MultiContent: historyParts,
	}

	messages := []openai.ChatCompletionMessage{
		{
			Role:    openai.ChatMessageRoleSystem,
			Content: systemPrompt,
		},
		userMsg,
	}

	if strings.TrimSpace(userQuestion) != "" {
		messages = append(messages, openai.ChatCompletionMessage{
			Role:    openai.ChatMessageRoleUser,
			Content: userQuestion,
		})
	}

	for attempt, effort := range ladder {
		req := openai.ChatCompletionRequest{
			Model:    c.cfg.AIModel,
			Messages: messages,
			Stream:   true,
		}

		isReasoningModel := strings.HasPrefix(c.cfg.AIModel, "o1") ||
			strings.HasPrefix(c.cfg.AIModel, "o3") ||
			strings.Contains(c.cfg.AIModel, "thinking") ||
			strings.Contains(c.cfg.AIModel, "r1")

		if effort != "none" || isReasoningModel {
			req.MaxCompletionTokens = 4096
			if effort != "none" {
				req.ReasoningEffort = effort
			}
		} else {
			req.MaxTokens = 4096
		}

		stream, err := c.client.CreateChatCompletionStream(ctx, req)
		if err != nil {
			lastErr = err
			errStr := err.Error()
			if strings.Contains(errStr, "content_filter") || strings.Contains(errStr, "safety") {
				return "", fmt.Errorf("CONTENT_FILTER_TRIGGERED: %w", err)
			}
			if attempt < len(ladder)-1 {
				time.Sleep(1 * time.Second)
				continue
			}
			break
		}

		var contentBuilder strings.Builder
		var contentFilterTriggered bool
		var streamErr error

		for {
			chunk, recvErr := stream.Recv()
			if errors.Is(recvErr, io.EOF) {
				break
			}
			if recvErr != nil {
				streamErr = recvErr
				break
			}

			if len(chunk.Choices) > 0 {
				if chunk.Choices[0].FinishReason == openai.FinishReasonContentFilter {
					contentFilterTriggered = true
				}
				contentBuilder.WriteString(chunk.Choices[0].Delta.Content)
			}
		}
		stream.Close()

		if contentFilterTriggered {
			return "", fmt.Errorf("CONTENT_FILTER_TRIGGERED: 内容触发安全过滤策略")
		}

		content := contentBuilder.String()
		if streamErr == nil && content != "" {
			return content, nil
		}

		if streamErr != nil {
			lastErr = streamErr
			errStr := streamErr.Error()
			if strings.Contains(errStr, "content_filter") || strings.Contains(errStr, "safety") {
				return "", fmt.Errorf("CONTENT_FILTER_TRIGGERED: %w", streamErr)
			}
		}

		if attempt < len(ladder)-1 {
			time.Sleep(1 * time.Second)
			continue
		}
	}

	if lastErr != nil {
		return "", lastErr
	}
	return "", fmt.Errorf("AI 请求未返回有效结果")
}

func (c *Client) SummarizeChat(ctx context.Context, messages []*storage.Message, quoteNotice string) (string, error) {
	prompt := c.cfg.SystemPromptSummary
	if prompt == "" {
		prompt = DefaultSystemPromptSummary
	}

	parts := c.BuildChatHistoryParts(messages)
	raw, err := c.CallChatModelWithReasoningRetry(ctx, prompt, parts, "")
	if err != nil {
		return "", err
	}
	return raw, nil
}

func (c *Client) AskChat(ctx context.Context, messages []*storage.Message, question, contextInfo string) (string, error) {
	prompt := c.cfg.SystemPromptAsk
	if prompt == "" {
		prompt = DefaultSystemPromptAsk
	}

	parts := c.BuildChatHistoryParts(messages)
	userQ := question
	if contextInfo != "" {
		userQ = fmt.Sprintf("【当前提问上下文】\n%s\n\n【用户问题】\n%s", contextInfo, question)
	}

	raw, err := c.CallChatModelWithReasoningRetry(ctx, prompt, parts, userQ)
	if err != nil {
		return "", err
	}
	return raw, nil
}

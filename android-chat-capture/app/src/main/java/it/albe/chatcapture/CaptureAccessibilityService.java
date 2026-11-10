package it.albe.chatcapture;

import android.accessibilityservice.AccessibilityService;
import android.content.SharedPreferences;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

public class CaptureAccessibilityService extends AccessibilityService {
    private static final String CHATGPT_PACKAGE="com.openai.chatgpt";
    private static final long STABLE_MS=2800;

    private final Handler handler=new Handler(Looper.getMainLooper());
    private String lastEditable="";
    private String lastTyped="";
    private String pendingUser="";
    private String lastUser="";
    private String assistantCandidate="";
    private String lastWindowDigest="";
    private long lastSnapshotPingAt=0;
    private long candidateChangedAt=0;
    private boolean awaitingAssistant=false;
    private String conversationId="";
    private String conversationTitle="ChatGPT";
    private final Runnable finalizeAssistant=this::maybeFinalizeAssistant;

    private static final Set<String> UI_BLACKLIST = new HashSet<>(Arrays.asList(
        "copy","copia","like","dislike","share","condividi","regenerate","rigenera",
        "read aloud","leggi ad alta voce","edit","modifica","stop","interrompi",
        "send","invia","new chat","nuova chat","voice","voce","attach","allega"
    ));

    @Override public void onServiceConnected() {
        super.onServiceConnected();
        SharedPreferences p=getSharedPreferences("capture",MODE_PRIVATE);
        conversationId=p.getString("current_conversation_id","");
        conversationTitle=p.getString("current_conversation_title","ChatGPT");
        if(conversationId.isEmpty()) newConversation("ChatGPT");
        try {
            JSONObject j=new JSONObject();
            j.put("kind","service_connected");
            j.put("packageName",CHATGPT_PACKAGE);
            ApiClient.ping(this,j);
        } catch(Exception ignored){}
        ApiClient.flush(this);
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if(event==null || event.getPackageName()==null) return;
        if(!CHATGPT_PACKAGE.contentEquals(event.getPackageName())) return;

        try {
            long now=System.currentTimeMillis();
            AccessibilityNodeInfo root=getRootInActiveWindow();
            String snapshot=root==null?"":windowSnapshot(root);
            String digest=hash(snapshot);
            if(now-lastSnapshotPingAt>800 || !digest.equals(lastWindowDigest)) {
                JSONObject d=new JSONObject();
                d.put("kind","window_snapshot");
                d.put("eventType",String.valueOf(event.getEventType()));
                d.put("packageName",String.valueOf(event.getPackageName()));
                d.put("text",snapshot.length()>3500?snapshot.substring(0,3500):snapshot);
                ApiClient.ping(this,d);
                lastSnapshotPingAt=now;
                lastWindowDigest=digest;
            }
        } catch(Exception ignored){}

        int type=event.getEventType();

        if(type==AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) {
            AccessibilityNodeInfo s=event.getSource();
            if(s!=null && s.isEditable()) {
                String t=nodeText(s).trim();
                if(!t.isEmpty()) {
                    lastTyped=t;
                    lastEditable=t;
                }
            }
        }

        if(type==AccessibilityEvent.TYPE_VIEW_CLICKED) {
            AccessibilityNodeInfo s=event.getSource();
            String clicked=nodeText(s).trim();
            String low=clicked.toLowerCase(Locale.ROOT);
            String id=s!=null && s.getViewIdResourceName()!=null?s.getViewIdResourceName().toLowerCase(Locale.ROOT):"";
            String desc=s!=null && s.getContentDescription()!=null?s.getContentDescription().toString().toLowerCase(Locale.ROOT):"";

            if(low.contains("new chat") || low.contains("nuova chat") || desc.contains("new chat") || desc.contains("nuova chat")) {
                newConversation("ChatGPT");
            } else if(
                low.equals("send") || low.equals("invia") ||
                desc.contains("send") || desc.contains("invia") ||
                id.contains("send")
            ) {
                if(!lastTyped.trim().isEmpty()) {
                    pendingUser=lastTyped.trim();
                    sendUser(pendingUser);
                    pendingUser="";
                    lastTyped="";
                }
            } else if((id.contains("conversation")||id.contains("history")) && isPossibleTitle(clicked)) {
                switchConversationByTitle(clicked);
            }
        }

        scan();
    }

    private void scan() {
        AccessibilityNodeInfo root=getRootInActiveWindow();
        if(root==null) return;
        ArrayList<NodeText> nodes=new ArrayList<>();
        collect(root,nodes);

        String editable="";
        for(NodeText n:nodes) if(n.editable && n.text.length()>=editable.length()) editable=n.text;

        if(!editable.isEmpty()) {
            lastEditable=editable;
            lastTyped=editable;
        }

        if(!pendingUser.isEmpty()) {
            boolean seen=false;
            for(NodeText n:nodes) if(!n.editable && normalize(n.text).equals(normalize(pendingUser))) {seen=true;break;}
            if(seen) {
                sendUser(pendingUser);
                pendingUser="";
            }
        }

        if(awaitingAssistant && !lastUser.isEmpty()) {
            String candidate=extractAfterUser(nodes,lastUser);
            if(!candidate.isEmpty() && !candidate.equals(assistantCandidate)) {
                assistantCandidate=candidate;
                candidateChangedAt=System.currentTimeMillis();
                handler.removeCallbacks(finalizeAssistant);
                handler.postDelayed(finalizeAssistant, STABLE_MS);
            }
        }
        ApiClient.flush(this);
    }

    private void sendUser(String text) {
        text=text.trim();
        if(text.isEmpty()) return;
        lastUser=text;
        awaitingAssistant=true;
        assistantCandidate="";
        candidateChangedAt=System.currentTimeMillis();
        postTurn("user",text,hash(conversationId+"|user|"+System.currentTimeMillis()+"|"+text));
    }

    private void maybeFinalizeAssistant() {
        if(!awaitingAssistant || assistantCandidate.trim().isEmpty()) return;
        long elapsed=System.currentTimeMillis()-candidateChangedAt;
        if(elapsed<STABLE_MS) {
            handler.postDelayed(finalizeAssistant, STABLE_MS-elapsed);
            return;
        }
        String text=assistantCandidate.trim();
        postTurn("assistant",text,hash(conversationId+"|assistant|"+text));
        awaitingAssistant=false;
        assistantCandidate="";
        lastUser="";
    }

    private void postTurn(String role,String text,String messageId) {
        try {
            JSONObject j=new JSONObject();
            j.put("conversationId",conversationId);
            j.put("messageId",messageId);
            j.put("title",conversationTitle);
            j.put("role",role);
            j.put("text",text);
            ApiClient.enqueue(this,j);
        } catch(Exception ignored){}
    }

    private String extractAfterUser(List<NodeText> nodes,String user) {
        int idx=-1;
        String nu=normalize(user);
        for(int i=0;i<nodes.size();i++) {
            NodeText n=nodes.get(i);
            if(!n.editable && normalize(n.text).equals(nu)) idx=i;
        }
        if(idx<0) return assistantCandidate;

        LinkedHashSet<String> parts=new LinkedHashSet<>();
        for(int i=idx+1;i<nodes.size();i++) {
            NodeText n=nodes.get(i);
            String t=n.text.trim();
            if(n.editable || t.isEmpty() || isUiText(t) || normalize(t).equals(nu)) continue;
            if(t.length()==1 && !Character.isLetterOrDigit(t.charAt(0))) continue;
            parts.add(t);
        }
        StringBuilder sb=new StringBuilder();
        for(String p:parts) {
            if(sb.length()>0) sb.append("\n\n");
            sb.append(p);
        }
        String s=sb.toString().trim();
        if(s.length()>3) return s;
        return assistantCandidate;
    }

    private void collect(AccessibilityNodeInfo n,List<NodeText> out) {
        if(n==null || !n.isVisibleToUser()) return;
        String t=nodeText(n).trim();
        if(!t.isEmpty()) {
            Rect r=new Rect(); n.getBoundsInScreen(r);
            out.add(new NodeText(t,n.isEditable(),r.top,r.bottom));
        }
        for(int i=0;i<n.getChildCount();i++) collect(n.getChild(i),out);
    }

    private String nodeText(AccessibilityNodeInfo n) {
        if(n==null) return "";
        CharSequence t=n.getText();
        if(t!=null && t.length()>0) return t.toString();
        CharSequence d=n.getContentDescription();
        return d==null?"":d.toString();
    }

    private String windowSnapshot(AccessibilityNodeInfo root) {
        ArrayList<NodeText> nodes=new ArrayList<>();
        collect(root,nodes);
        StringBuilder sb=new StringBuilder();
        int i=0;
        for(NodeText n:nodes) {
            String t=n.text==null?"":n.text.trim();
            if(t.isEmpty()) continue;
            if(sb.length()>0) sb.append("\n");
            sb.append(i++).append("|").append(n.editable?"E":"T").append("|").append(t.replace("\n"," ↵ "));
            if(sb.length()>5000) break;
        }
        return sb.toString();
    }

    private boolean isUiText(String s) {
        String l=s.trim().toLowerCase(Locale.ROOT);
        if(UI_BLACKLIST.contains(l)) return true;
        if(l.startsWith("chatgpt can make mistakes") || l.startsWith("chatgpt può commettere errori")) return true;
        if(l.matches("^(copy|copia|share|condividi|like|dislike|edit|modifica).*$")) return true;
        return false;
    }

    private boolean isPossibleTitle(String s) {
        String x=s==null?"":s.trim();
        if(x.length()<3 || x.length()>100 || isUiText(x)) return false;
        String l=x.toLowerCase(Locale.ROOT);
        return !l.equals("chatgpt") && !l.startsWith("gpt-");
    }

    private void switchConversationByTitle(String title) {
        SharedPreferences p=getSharedPreferences("capture",MODE_PRIVATE);
        String key="title_"+hash(title).substring(0,16);
        String id=p.getString(key,"");
        if(id.isEmpty()) id=UUID.randomUUID().toString();
        conversationId=id;
        conversationTitle=title;
        p.edit().putString(key,id).putString("current_conversation_id",id).putString("current_conversation_title",title).apply();
        resetTurnState();
    }

    private void newConversation(String title) {
        conversationId=UUID.randomUUID().toString();
        conversationTitle=title;
        getSharedPreferences("capture",MODE_PRIVATE).edit()
            .putString("current_conversation_id",conversationId)
            .putString("current_conversation_title",conversationTitle).apply();
        resetTurnState();
    }

    private void resetTurnState() {
        lastEditable=""; lastTyped=""; pendingUser=""; lastUser=""; assistantCandidate=""; awaitingAssistant=false;
        handler.removeCallbacks(finalizeAssistant);
    }

    private String normalize(String s){return s==null?"":s.trim().replaceAll("\\s+"," ");}

    private String hash(String s) {
        try {
            byte[] b=MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb=new StringBuilder();
            for(byte x:b) sb.append(String.format(Locale.ROOT,"%02x",x));
            return sb.toString();
        } catch(Exception e) { return UUID.randomUUID().toString().replace("-",""); }
    }

    @Override public void onInterrupt(){}

    static class NodeText {
        final String text; final boolean editable; final int top,bottom;
        NodeText(String t,boolean e,int a,int b){text=t;editable=e;top=a;bottom=b;}
    }
}
